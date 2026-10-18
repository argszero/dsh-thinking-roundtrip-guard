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
import type { Context } from '@deepseek-ai/cordis';
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Settings } from './config.ts';
import type { RepairedTurn } from './repair.ts';
/** How the listener reports what it did, and what it could not do. */
export interface OutboundPolicy {
    /** One repair is about to be dispatched. */
    readonly onRepair: (options: GenerateOptions, turns: readonly RepairedTurn[]) => void;
    /** One request would have been repaired; nothing was changed. */
    readonly onObserve: (options: GenerateOptions, turns: readonly RepairedTurn[]) => void;
    /** One request is being sent with reasoning off. */
    readonly onDegrade: (options: GenerateOptions, why: 'mode' | 'escalation') => void;
    /** One repaired request was rejected with nothing visible emitted, and is being retried. */
    readonly onEscalate: (failure: {
        readonly message: string;
        readonly status?: number;
    }) => void;
    /** A repair threw; the original request was dispatched unchanged. */
    readonly onFailure: (error: unknown) => void;
}
/**
 * Whether a route is one this plugin may touch.
 * @param providers - the configured allowlist; empty admits every route.
 * @param provider - the route name on the request.
 * @returns whether the request may be repaired.
 */
export declare function allowed(providers: readonly string[], provider: string): boolean;
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
export declare function isThinkingRejection(reason: FinishReason | undefined): reason is Extract<FinishReason, {
    kind: 'error';
}>;
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
export declare function escalate(first: AsyncIterable<StreamChunk>, fallback: () => AsyncIterable<StreamChunk> | undefined, policy: OutboundPolicy): AsyncIterable<StreamChunk>;
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
export declare function installOutbound(ctx: Context, settings: Settings, policy: OutboundPolicy): void;
//# sourceMappingURL=outbound.d.ts.map