/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime`, and the
 * REAL `llm/stream` waterfall.
 *
 * Nothing about the seam is simulated. The plugin listens on `llm/stream`, and
 * this harness dispatches **that** waterfall — `ctx.waterfall(ctx.llm,
 * 'llm/stream', options, () => source)` — with the registry instance as the
 * listener `this`, exactly as `LlmRuntime.streamWithRegistration` does:
 *
 * ```ts
 * // packages/llm/llm/src/index.ts
 * stream(options) { return this.streamWithRegistration(options) }
 * streamWithRegistration(options) { return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options)) }
 * ```
 *
 * So what is measured is Cordis' own dispatch — the same listener list, the same
 * `prepend` placement, the same `next()` composition, the same `global` filter
 * bypass — plus the plugin's own re-dispatch through `ctx.llm.stream()`, which is
 * the real public entry point and therefore re-enters the real waterfall.
 *
 * ## The adapter double
 *
 * `llm/stream`'s `next` is the adapter. This harness registers a probe listener
 * that records the request it is handed and returns a fabricated chunk stream
 * without calling `next()` — the adapter's job, done by the test. Because the
 * plugin registers with `prepend: true`, the probe never sees a request the
 * plugin still means to repair: the plugin re-dispatches before calling `next`,
 * so the request the probe records is the one an adapter would have received.
 * That is the assertion, and it is made on real dispatch rather than on the
 * plugin's return value.
 *
 * `harness.reply` decides what the probe answers for one request, which is how
 * the response-side escalation is driven: the probe rejects the repaired request
 * with the reported 400 and accepts the degraded one.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/** A stream of chunks, as the adapter would have yielded them. */
export async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/** Drain an async iterable into an array. */
export async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/** One finished chunk, the smallest thing a consumer needs to end a stream. */
export const FINISH = { type: 'finish', reason: { kind: 'stop' } }

/** One visible content chunk. */
export const TEXT = { type: 'text-delta', index: 0, text: 'ok' }

/** The reported rejection, as the transport projects it. */
export const THINKING_400 = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'The `content[].thinking` in the thinking mode must be passed back to the API.',
      code: 'INVALID_REQUEST',
      status: 400,
    },
  },
}

/** A different 400 — the shape a repair must not react to. */
export const CONTENT_400 = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 },
  },
}

/** Deep-freeze a value, as a loop-built request arrives. */
export function deepFrozen(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFrozen(entry)
  }
  return value
}

/** One assistant turn carrying `calls` tool calls, without a reasoning block. */
export function assistantTurn(id, calls = 1, text = 'working') {
  return {
    id,
    role: 'assistant',
    source: { kind: 'model' },
    content: [
      { type: 'text', text },
      ...Array.from({ length: calls }, (_, index) => ({
        type: 'tool-call',
        id: `${id}-call-${index}`,
        name: 'read',
        arguments: '{"path":"a.ts"}',
      })),
    ],
  }
}

/** One assistant turn that already carries its reasoning block. */
export function reasoningTurn(id) {
  return {
    id,
    role: 'assistant',
    source: { kind: 'model' },
    content: [
      { type: 'reasoning', text: 'recorded by this route' },
      { type: 'text', text: 'working' },
      { type: 'tool-call', id: `${id}-call-0`, name: 'read', arguments: '{}' },
    ],
  }
}

/** One tool result answering `id`. */
export function toolResult(id) {
  return {
    id: `${id}-result`,
    role: 'tool',
    source: { kind: 'tool', name: 'read' },
    toolCallId: `${id}-call-0`,
    content: [{ type: 'text', text: 'done' }],
  }
}

/** One user message. */
export function userMessage(text = 'continue') {
  return { id: `u-${text.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/**
 * A request mixing two routes: a repair target followed by a plain user turn.
 * @param options - provider, effort and any extra messages.
 * @returns a `GenerateOptions`-shaped object.
 */
export function mixedHistory(options = {}) {
  return {
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-flash',
    messages: options.messages ?? [
      userMessage('first'),
      assistantTurn('a1'),
      toolResult('a1'),
      userMessage('second'),
    ],
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}

/**
 * Mount a real context with the real LLM registry, a probe standing in for the
 * adapter, and this plugin.
 *
 * `plugin: false` mounts everything except the plugin — the control arm, which is
 * what turns "the adapter received a thinking block" into "the plugin put it
 * there".
 * @param spec - `plugin` (false or undefined), `config`.
 * @returns the context, the captured log, and the handles a spec drives it with.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 3 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)

  const harness = {
    ctx,
    logged,
    /** Every request the probe was handed, oldest first. */
    seen: [],
    /** Decides what the probe answers for one request; defaults to one stop frame. */
    reply: () => [FINISH],
    fork: undefined,
    /**
     * Dispatch the real `llm/stream` waterfall and drain what the consumer
     * receives. The probe terminates the chain, so no adapter is needed.
     * @param options - the request.
     * @returns the chunks the consumer saw.
     */
    async stream(options) {
      return collect(ctx.waterfall(ctx.llm, 'llm/stream', options, () => streamOf([FINISH])))
    },
    /** The plugin's own read-only view, or undefined when it did not provide one. */
    snapshot() {
      return ctx.get('thinkingRoundtripGuard')?.snapshot()
    },
    async mount() {
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      return harness
    },
    async dispose() {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }

  // The probe is the adapter. It records and terminates — it never calls `next`,
  // because there is nothing behind it to call.
  ctx.on('llm/stream', (options) => {
    harness.seen.push(options)
    return streamOf(harness.reply(options))
  })

  if (spec.plugin !== false) await harness.mount()
  return harness
}
