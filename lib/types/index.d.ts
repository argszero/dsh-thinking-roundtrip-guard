/**
 * A mixed-provider session stops being a one-way door.
 *
 * ## The gap
 *
 * A Messages-shaped route with thinking enabled requires every **historical**
 * assistant turn that carries a tool call to carry a thinking block too. Its own
 * sentence, from the reported failure: *"The `content[].thinking` in the thinking
 * mode must be passed back to the API."*
 *
 * dsh's serializer emits a thinking block only where the durable message already
 * holds a `reasoning` block, and a turn produced on another route — a pi-ai
 * route, a different dialect — is durable as text plus a tool call with no
 * reasoning block at all. So the moment a session mixes routes, switching back
 * leaves turns the endpoint refuses. Because the history is append-only, the
 * refusal repeats on **every** later request, including a plain-text follow-up:
 * the session can never use that route again.
 *
 * ## What this plugin does about it
 *
 * It repairs the **outbound** request, at the one seam every model call crosses:
 * the `llm/stream` waterfall.
 *
 * | mode | what it sends |
 * |---|---|
 * | `synthesize` (default) | the same history, with a placeholder thinking block inserted ahead of each tool-carrying turn that had none |
 * | `degrade` | the same history with reasoning effort `off` — the shape a thinking-disabled route accepts |
 * | `observe` | nothing: it counts what `synthesize` would repair, so an operator can see the scope before trusting it |
 * | `off` | nothing, and no listener installed |
 *
 * `synthesize` is the default because a signature is not what the endpoint asks
 * for: the reporter measured the live endpoint and a thinking block **without** a
 * signature answers `200`. And because a synthesized block is still a claim about
 * a turn this process did not produce, `synthesize` also reads the response: a
 * rejection that arrives before any visible output is withheld, and the original
 * history is retried with reasoning off. Where the provider's wording differs from
 * the measured case, `degrade` is the deterministic escape — it reads nothing.
 *
 * ## What it does not claim, and does not touch
 *
 * - **The durable session log is untouched.** The repair exists in the request
 *   this process is about to send; the session keeps the history it recorded, so
 *   the workaround is revocable and nothing an operator wrote is rewritten.
 * - **The tool-call pairing checks stay where they are.** The serializer's local
 *   `INVALID_REQUEST` precheck validates tool ids; this plugin repairs thinking
 *   blocks and does not touch that.
 * - **The core fix is not this.** The right place for it is the serializer or the
 *   request assembly, where the route's own thinking policy is known; a plugin
 *   cannot see a connection's defaults. Until then this keeps the session usable.
 * - **A rejection worded without "thinking" is not classified.** Reacting to every
 *   400 would hide a content rejection or an exhausted window behind a degraded
 *   retry that cannot help. `mode: 'degrade'` covers that case without reading the
 *   provider at all.
 *
 * Every one of those is reported by `snapshot()` rather than left for an operator
 * to discover.
 *
 * @module @argszero/dsh-thinking-roundtrip-guard
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config, GuardMode } from './config.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "thinking-roundtrip-guard";
/**
 * The service this plugin is about: the request seam re-dispatches through
 * `ctx.llm.stream`, and a composition with no models has no request to repair.
 */
export declare const inject: string[];
/** The name under which the read-only view is provided. */
export declare const SERVICE = "thinkingRoundtripGuard";
/** What an operator may read back, and what the plugin will not do. */
export interface Snapshot {
    /** The resolved mode. */
    readonly mode: GuardMode;
    /** Route names the plugin may touch; empty means every route. */
    readonly providers: readonly string[];
    /** Whether a rejected repair is retried with reasoning off. */
    readonly escalate: boolean;
    /** Requests whose history was repaired before dispatch. */
    readonly requestsRepaired: number;
    /** Turns that received a synthesized thinking block, in total. */
    readonly turnsRepaired: number;
    /** Requests a repair would have changed, counted in `observe` mode only. */
    readonly requestsObserved: number;
    /** Requests sent with reasoning off — by `mode: 'degrade'` or by escalation. */
    readonly requestsDegraded: number;
    /** Repaired requests the endpoint rejected, retried with reasoning off. */
    readonly escalations: number;
    /** Repairs that threw, each leaving the original request to be dispatched. */
    readonly errors: number;
    /** Configuration values that were refused, with what the plugin used instead. */
    readonly notes: readonly string[];
    /** What this plugin does not cover, on every read. */
    readonly blindSpots: readonly string[];
}
/** The read-only view provided under {@link SERVICE}. */
export interface ThinkingRoundtripGuardService {
    snapshot(): Snapshot;
}
/**
 * Mount the guard.
 * @param ctx - the context the plugin is mounted on.
 * @param config - the operator's configuration; every field is optional.
 */
export declare function apply(ctx: Context, config?: Config): void;
export type { Config, GuardMode, Settings } from './config.ts';
export { defaultConfig, DEFAULT_PLACEHOLDER, normalizeConfig } from './config.ts';
export type { OutboundPolicy } from './outbound.ts';
export { allowed, escalate, installOutbound, isThinkingRejection } from './outbound.ts';
export type { RepairReport, RepairedTurn } from './repair.ts';
export { degrade, needsThinking, offenders, repair, synthesize } from './repair.ts';
/**
 * The object a loader entry mounts: the loader normalises a plugin module with
 * `exports.default ?? exports` and hands this to `ctx.plugin`.
 *
 * Deliberately no `Config` key — a plain defaults object has no `~standard` and
 * every mount of a package that exports one as `Config` dies before `apply` runs.
 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map