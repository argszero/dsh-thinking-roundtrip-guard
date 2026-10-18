/**
 * The repair itself, as a pure function over one request.
 *
 * ## What the provider is asking for
 *
 * On a Messages-shaped route with thinking enabled, the endpoint requires every
 * **historical** assistant turn that carries a tool call to carry a thinking
 * block as well — and it requires it of the whole history, not only of the turn
 * being sent. Its own words, from the reported failure: *"The `content[].thinking`
 * in the thinking mode must be passed back to the API."*
 *
 * dsh's Messages serializer emits a thinking block only where the durable message
 * already holds a `reasoning` block:
 *
 * ```ts
 * // packages/llm/llm-deepseek/src/serialize.ts
 * case 'reasoning': return { type: 'thinking', thinking: block.text, ...signature }
 * case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
 * ```
 *
 * A turn produced on a *different* route — a pi-ai route, another provider's
 * dialect — is durable as `text` + `tool-call` with no `reasoning` block at all.
 * So the moment a session mixes routes, switching back leaves turns the endpoint
 * refuses, and because the history is append-only the refusal repeats on every
 * later request: the session is stuck on that route for good.
 *
 * ## Why synthesizing a block is legal here
 *
 * A signature is not the thing being asked for. The reporter measured the
 * matrix on the live endpoint: a thinking block **without** a signature answers
 * `200`, with a signature `200`, and the same turn without a thinking block
 * `400`. In this repository a `ReasoningBlock` is `{ type, text }` — the
 * signature lives beside it, index-aligned in the replay envelope — so a
 * signature-less reasoning block is a shape the durable model already allows and
 * the serializer already sends. Synthesizing one is therefore not a forgery the
 * protocol rejects; it is the entry the protocol wants, with the content honestly
 * marked as unavailable.
 *
 * The block is inserted **first** in the turn's content, because a thinking block
 * that follows text or a tool call is not the shape the dialect defines.
 *
 * ## What this does not touch
 *
 * The durable session log. The repair lives in the request this process is about
 * to send: the session keeps exactly the history it recorded, so revoking the
 * plugin revokes the repair, and nothing an operator wrote is rewritten in place.
 *
 * @module @argszero/dsh-thinking-roundtrip-guard/repair
 */
import type { AssistantMessage, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm';
/** One turn the plugin would repair, named by its message identity. */
export interface RepairedTurn {
    /** Durable identity of the assistant message, as the session records it. */
    readonly id: string;
    /** Tool calls in the turn — the reason the block is required at all. */
    readonly calls: number;
}
/** What one pass over a request found, and the request to send instead. */
export interface RepairReport {
    /** The replacement request, or `undefined` when the request needed no repair. */
    readonly options: GenerateOptions | undefined;
    /** Turns that were missing a thinking block. */
    readonly turns: readonly RepairedTurn[];
    /** Assistant messages whose content was rewritten. */
    readonly repaired: number;
}
/**
 * Whether one message is a turn the endpoint would refuse.
 *
 * The predicate is exactly the reported condition and nothing wider: an assistant
 * turn that carries at least one tool call and carries no reasoning block. A
 * text-only assistant turn is accepted without one (measured), so it is left
 * alone; a turn that already has a reasoning block is left alone too, however
 * short that block is.
 * @param message - one message from the request history.
 * @returns whether the turn needs a synthesized thinking block.
 */
export declare function needsThinking(message: RequestMessage): message is AssistantMessage;
/**
 * Insert the placeholder reasoning block ahead of one turn's existing content.
 * @param message - the assistant turn to repair.
 * @param placeholder - non-empty text of the synthesized block.
 * @returns a new, shallow-frozen message; the caller's message is untouched.
 */
export declare function synthesize(message: AssistantMessage, placeholder: string): AssistantMessage;
/**
 * Build the request that carries a thinking block for every turn that lacks one.
 *
 * The request object and the messages it rewrites are frozen; the messages this
 * function does not rewrite are passed through by reference, so a caller's own
 * objects are never frozen as a side effect of a repair.
 * @param options - the outbound request.
 * @param placeholder - non-empty text of every synthesized block.
 * @returns the replacement request, or `undefined` when nothing needed repair.
 */
export declare function repair(options: GenerateOptions, placeholder: string): RepairReport;
/**
 * Count the turns a repair would touch, without building one.
 * @param options - the outbound request.
 * @returns every turn the endpoint would refuse.
 */
export declare function offenders(options: GenerateOptions): readonly RepairedTurn[];
/**
 * Build the same history with reasoning disabled.
 *
 * This is the shape the reporter measured as accepted with tool-call history and
 * thinking off, which makes it the deterministic escape when the synthesized
 * block is not enough: no thinking block is required of a route that is not
 * thinking.
 * @param options - the outbound request.
 * @returns the degraded request, or `undefined` when reasoning was already off.
 */
export declare function degrade(options: GenerateOptions): GenerateOptions | undefined;
//# sourceMappingURL=repair.d.ts.map