/**
 * The listener, and the escalation behind it.
 *
 * ## Why it re-dispatches
 *
 * A loop-built request arrives deep frozen — the waterfall's contract is that its
 * content is a pure function of the session log, so listeners read it and never
 * rewrite it — and the waterfall's `next` takes no argument. The only way to give
 * the adapter a different request is to ask the runtime for a stream of that
 * request:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * stream(options) { return this.streamWithRegistration(options) }
 * ```
 *
 * The re-dispatch re-enters this same waterfall, so this listener is called again
 * with the replacement. Identity is what stops the recursion: every request this
 * plugin builds is recorded in a `WeakSet`, and an already-recorded request is
 * passed to `next()` untouched. A request with no turn to repair never leaves the
 * ordinary path at all, so the extra dispatch preparation is paid only where a
 * repair was actually made.
 *
 * ## Why the response side is read too
 *
 * A synthesized block is accepted by the endpoint the report measured, but it is
 * still a claim about a turn this process cannot verify. If a route rejects the
 * repaired request, the rejection arrives as the stream's terminal frame — an
 * adapter throw is converted into `{ type: 'finish', reason: { kind: 'error' } }`
 * before any consumer sees it:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * function adapterFailureChunk(error, signal) { ... return { type: 'finish', reason: { kind: 'error', failure } } }
 * ```
 *
 * So the wrapper below holds that frame instead of forwarding it, and — only when
 * nothing visible has been emitted yet, so nothing is replayed that the consumer
 * already saw — retries the *original* history with reasoning off, which is the
 * shape a thinking-disabled route accepts. If that retry fails too, its own frame
 * is the one the consumer gets.
 *
 * ## The failure this cannot classify
 *
 * The provider's own words do reach `failure.message` (the Messages transport
 * copies `error.message` straight through), so the discriminator is the sentence
 * that names thinking, not the code. A 400 that says something else is left
 * alone: a repair that reacted to every 400 would mask a content rejection, a
 * tool-pairing error or an exhausted window behind a degraded retry that cannot
 * possibly help. Where the wording differs, `mode: 'degrade'` is the
 * deterministic escape — it does not depend on reading the provider at all.
 *
 * @module @argszero/dsh-thinking-roundtrip-guard/outbound
 */
import { degrade, offenders, repair } from "./repair.js";
/**
 * Whether a route is one this plugin may touch.
 * @param providers - the configured allowlist; empty admits every route.
 * @param provider - the route name on the request.
 * @returns whether the request may be repaired.
 */
export function allowed(providers, provider) {
    return providers.length === 0 || providers.includes(provider);
}
/** Chunk types that put something in front of the caller. */
const VISIBLE = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end']);
/**
 * Whether a terminal frame is the endpoint refusing a thinking round-trip.
 *
 * Both halves are required: the frame must be an error, and the provider's own
 * sentence must name thinking. `status === 400` alone would match content
 * moderation as well, and a degraded retry of a content rejection costs a request
 * and fixes nothing.
 * @param reason - the finish reason, or `undefined` when the frame carries none.
 * @returns whether the frame is the reported rejection.
 */
export function isThinkingRejection(reason) {
    if (reason === undefined || reason.kind !== 'error')
        return false;
    const { failure } = reason;
    if (failure.status !== undefined && failure.status !== 400)
        return false;
    return /thinking/i.test(failure.message);
}
/** The same test for a thrown error, because a stream may fail either way. */
function isThinkingRejectionError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const record = error;
    if (record.status !== undefined && record.status !== 400)
        return false;
    return typeof record.message === 'string' && /thinking/i.test(record.message);
}
/**
 * Forward the first stream, and replace its terminal error frame with a degraded
 * retry when — and only when — it is the thinking rejection and nothing visible
 * has been forwarded yet.
 * @param first - the repaired attempt's stream.
 * @param fallback - builds the degraded attempt, at most once, or `undefined`
 *   when the history has nothing left to degrade.
 * @param policy - where the escalation is reported.
 * @returns what the consumer receives.
 */
export async function* escalate(first, fallback, policy) {
    let visible = false;
    try {
        for await (const chunk of first) {
            if (chunk.type === 'finish' && !visible && isThinkingRejection(chunk.reason)) {
                const alternative = fallback();
                if (alternative !== undefined) {
                    // Hold the frame: yielding it would report a failure the caller may
                    // never experience, and the retry's own outcome is the truth.
                    policy.onEscalate(chunk.reason.failure);
                    yield* alternative;
                    return;
                }
            }
            if (VISIBLE.has(chunk.type))
                visible = true;
            yield chunk;
        }
    }
    catch (error) {
        if (visible || !isThinkingRejectionError(error))
            throw error;
        const alternative = fallback();
        if (alternative === undefined)
            throw error;
        policy.onEscalate({
            message: error instanceof Error ? error.message : String(error),
            ...(typeof error.status === 'number'
                ? { status: error.status }
                : {}),
        });
        yield* alternative;
    }
}
/**
 * Install the listener on the `llm/stream` waterfall.
 *
 * `global` because the stream is dispatched with the registry instance as the
 * listener's `this`, so a mount scoped to a profile must still cover it; `prepend`
 * so this is the first listener to see the request, which is what keeps another
 * listener from forwarding a history the endpoint would refuse.
 * @param ctx - the context to register on.
 * @param settings - the resolved configuration.
 * @param policy - where to report.
 */
export function installOutbound(ctx, settings, policy) {
    const dispatched = new WeakSet();
    ctx.on('llm/stream', (options, next) => {
        try {
            if (dispatched.has(options))
                return next();
            if (settings.mode === 'off')
                return next();
            if (!allowed(settings.providers, options.provider))
                return next();
            // A request that states reasoning is off needs no thinking block back, and
            // inserting one would be the inverse of the hazard this plugin covers.
            if (options.reasoningEffort === 'off')
                return next();
            if (settings.mode === 'observe') {
                const turns = offenders(options);
                if (turns.length > 0)
                    policy.onObserve(options, turns);
                return next();
            }
            if (settings.mode === 'degrade') {
                const degraded = degrade(options);
                if (degraded === undefined)
                    return next();
                dispatched.add(degraded);
                policy.onDegrade(options, 'mode');
                return ctx.llm.stream(degraded);
            }
            const report = repair(options, settings.placeholder);
            if (report.options === undefined)
                return next();
            dispatched.add(report.options);
            policy.onRepair(options, report.turns);
            const first = ctx.llm.stream(report.options);
            if (!settings.escalate)
                return first;
            return escalate(first, () => {
                // The escalation starts from the *original* history, not from the
                // repaired one: with thinking off, the endpoint does not want the
                // synthesized block either, and the reported matrix shows this exact
                // shape — tool-call history, no thinking blocks, thinking disabled —
                // answering 200.
                const degraded = degrade(options);
                if (degraded === undefined)
                    return undefined;
                dispatched.add(degraded);
                policy.onDegrade(options, 'escalation');
                return ctx.llm.stream(degraded);
            }, policy);
        }
        catch (error) {
            // Fail open, and say so: a request that cannot be repaired is dispatched
            // exactly as the caller assembled it. A guard that dropped a working model
            // call would be a worse failure than the one it prevents.
            policy.onFailure(error);
            return next();
        }
    }, { global: true, prepend: true });
}
