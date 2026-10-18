/**
 * The seam: what an adapter actually receives, measured on the real `llm/stream`
 * waterfall with the real registry.
 *
 * The control arm (no plugin) is what makes the repair arm meaningful — it shows
 * the request an adapter gets today, so "the adapter received a thinking block"
 * is attributable to the plugin rather than to the fixture.
 *
 * @module test/outbound.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { world, FINISH, TEXT, THINKING_400, CONTENT_400, assistantTurn, deepFrozen, mixedHistory, reasoningTurn, toolResult, userMessage } from './harness.mjs'

const PLACEHOLDER = 'stand-in reasoning'

describe('the seam, with no plugin', () => {
  it('hands the adapter a tool-carrying turn with no thinking block', async () => {
    const h = await world({ plugin: false })
    await h.stream(mixedHistory())
    assert.equal(h.seen.length, 1)
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.seen[0].messages[1].content.some(block => block.type === 'reasoning'), false)
  })
})

describe('synthesize (the default)', () => {
  it('hands the adapter a thinking block ahead of the tool call', async () => {
    const h = await world({ config: { placeholder: PLACEHOLDER } })
    const options = mixedHistory()
    const chunks = await h.stream(options)
    assert.equal(h.seen.length, 1)
    const turn = h.seen[0].messages[1]
    assert.equal(turn.content[0].type, 'reasoning')
    assert.equal(turn.content[0].text, PLACEHOLDER)
    assert.equal(turn.content[1].type, 'text')
    assert.ok(turn.content.some(block => block.type === 'tool-call'))
    assert.deepEqual(chunks, [FINISH])
    assert.equal(h.snapshot().requestsRepaired, 1)
    assert.equal(h.snapshot().turnsRepaired, 1)
  })

  it('dispatches a request with nothing to repair straight to the adapter', async () => {
    const h = await world()
    await h.stream(mixedHistory({ messages: [userMessage(), reasoningTurn('a9'), toolResult('a9')] }))
    assert.equal(h.seen.length, 1)
    assert.equal(h.snapshot().requestsRepaired, 0)
  })

  it('does not rewrite the caller\'s request', async () => {
    const h = await world()
    const options = mixedHistory()
    const before = structuredClone(options)
    await h.stream(options)
    assert.deepEqual(structuredClone(options), before)
  })

  it('repairs a deep-frozen loop-built request without mutating it', async () => {
    const h = await world()
    const options = deepFrozen(mixedHistory())
    await h.stream(options)
    assert.equal(h.seen[0].messages[1].content[0].type, 'reasoning')
    assert.equal(Object.isFrozen(h.seen[0]), true)
  })

  it('leaves a route outside the allowlist alone', async () => {
    const h = await world()
    await h.stream(mixedHistory({ provider: 'workbuddy' }))
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.snapshot().requestsRepaired, 0)
  })

  it('covers every route when the allowlist is empty', async () => {
    const h = await world({ config: { providers: [] } })
    await h.stream(mixedHistory({ provider: 'workbuddy' }))
    assert.equal(h.seen[0].messages[1].content[0].type, 'reasoning')
  })

  it('does nothing when the request already states reasoning is off', async () => {
    const h = await world()
    await h.stream(mixedHistory({ reasoningEffort: 'off' }))
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.snapshot().requestsRepaired, 0)
  })

  it('repairs each dispatch of the same history independently', async () => {
    const h = await world()
    await h.stream(mixedHistory())
    await h.stream(mixedHistory())
    assert.equal(h.seen.length, 2)
    assert.equal(h.snapshot().requestsRepaired, 2)
    assert.equal(h.seen[1].messages[1].content[0].type, 'reasoning')
  })
})

describe('degrade mode', () => {
  it('sends reasoning off and the history as recorded', async () => {
    const h = await world({ config: { mode: 'degrade' } })
    await h.stream(mixedHistory({ reasoningEffort: 'high' }))
    assert.equal(h.seen[0].reasoningEffort, 'off')
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.snapshot().requestsDegraded, 1)
    assert.equal(h.snapshot().requestsRepaired, 0)
  })

  it('dispatches unchanged when reasoning was already off', async () => {
    const h = await world({ config: { mode: 'degrade' } })
    await h.stream(mixedHistory({ reasoningEffort: 'off' }))
    assert.equal(h.seen.length, 1)
    assert.equal(h.snapshot().requestsDegraded, 0)
  })
})

describe('observe mode', () => {
  it('counts the turns it would repair and changes nothing', async () => {
    const h = await world({ config: { mode: 'observe' } })
    await h.stream(mixedHistory())
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.snapshot().requestsObserved, 1)
    assert.equal(h.snapshot().requestsRepaired, 0)
  })
})

describe('escalation', () => {
  it('withholds the thinking rejection and retries the original history with reasoning off', async () => {
    const h = await world()
    h.reply = options => options.messages[1].content[0].type === 'reasoning' ? [THINKING_400] : [FINISH]
    const chunks = await h.stream(mixedHistory({ reasoningEffort: 'high' }))
    assert.equal(h.seen.length, 2)
    assert.equal(h.seen[0].messages[1].content[0].type, 'reasoning')
    assert.equal(h.seen[1].reasoningEffort, 'off')
    assert.equal(h.seen[1].messages[1].content[0].type, 'text')
    assert.deepEqual(chunks, [FINISH])
    assert.equal(h.snapshot().escalations, 1)
    assert.equal(h.snapshot().requestsDegraded, 1)
  })

  it('forwards a different 400 unchanged', async () => {
    const h = await world()
    h.reply = () => [CONTENT_400]
    const chunks = await h.stream(mixedHistory())
    assert.equal(h.seen.length, 1)
    assert.deepEqual(chunks, [CONTENT_400])
    assert.equal(h.snapshot().escalations, 0)
  })

  it('does not retry once visible output has been forwarded', async () => {
    const h = await world()
    h.reply = () => [TEXT, THINKING_400]
    const chunks = await h.stream(mixedHistory())
    assert.equal(h.seen.length, 1)
    assert.deepEqual(chunks, [TEXT, THINKING_400])
    assert.equal(h.snapshot().escalations, 0)
  })

  it('surfaces the retry\'s own failure when the retry fails too', async () => {
    const h = await world()
    h.reply = () => [THINKING_400]
    const chunks = await h.stream(mixedHistory())
    assert.equal(h.seen.length, 2)
    // exactly one terminal frame reaches the consumer, and it is the retry's
    const finishes = chunks.filter(chunk => chunk.type === 'finish')
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].reason.kind, 'error')
    assert.equal(h.snapshot().escalations, 1)
  })

  it('can be turned off', async () => {
    const h = await world({ config: { escalate: false } })
    h.reply = () => [THINKING_400]
    const chunks = await h.stream(mixedHistory())
    assert.equal(h.seen.length, 1)
    assert.deepEqual(chunks, [THINKING_400])
    assert.equal(h.snapshot().escalations, 0)
  })

  it('has nothing to escalate when the request already asked for reasoning off', async () => {
    const h = await world()
    h.reply = () => [THINKING_400]
    await h.stream(mixedHistory({ reasoningEffort: 'off' }))
    assert.equal(h.seen.length, 1)
    assert.equal(h.snapshot().escalations, 0)
  })
})

describe('the listener\'s own failures fail open', () => {
  it('dispatches the original request when a repair throws', async () => {
    const h = await world()
    // A message whose `content` is not iterable makes the repair throw.
    const broken = { provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ id: 'x', role: 'assistant', source: { kind: 'model' }, content: null }] }
    const chunks = await h.stream(broken)
    assert.equal(h.seen.length, 1)
    assert.equal(h.seen[0], broken)
    assert.deepEqual(chunks, [FINISH])
    assert.equal(h.snapshot().errors, 1)
  })
})

describe('disposal', () => {
  it('stops repairing once the plugin is disposed', async () => {
    const h = await world()
    await h.stream(mixedHistory())
    assert.equal(h.seen[0].messages[1].content[0].type, 'reasoning')
    await h.dispose()
    await h.stream(mixedHistory())
    assert.equal(h.seen[1].messages[1].content[0].type, 'text')
  })
})

describe('a long mixed session', () => {
  it('repairs every turn the endpoint would refuse, in one request', async () => {
    const h = await world()
    const messages = [
      userMessage('one'),
      assistantTurn('a1'),
      toolResult('a1'),
      userMessage('two'),
      { ...assistantTurn('a2'), content: [{ type: 'text', text: 'from another route' }, { type: 'tool-call', id: 'a2-call-0', name: 'grep', arguments: '{}' }, { type: 'tool-call', id: 'a2-call-1', name: 'read', arguments: '{}' }] },
      toolResult('a2'),
      userMessage('three'),
      reasoningTurn('a3'),
      toolResult('a3'),
    ]
    await h.stream(mixedHistory({ messages }))
    const sent = h.seen[0].messages
    assert.equal(sent[1].content[0].type, 'reasoning')
    assert.equal(sent[4].content[0].type, 'reasoning')
    // the turn that recorded its own reasoning keeps its exact content
    assert.equal(sent[7], messages[7])
    assert.equal(h.snapshot().turnsRepaired, 2)
  })
})
