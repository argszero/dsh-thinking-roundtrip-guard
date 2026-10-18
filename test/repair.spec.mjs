/**
 * The repair as a pure function: what counts as a turn needing a thinking block,
 * what the replacement looks like, and what is left untouched.
 *
 * The last part is the one that matters most and is easiest to get wrong: a
 * repair that rewrote the caller's request in place would corrupt a frozen
 * loop-built request (mutation throws) or a hand-built caller's own inputs. Every
 * assertion below that reads an *original* object is therefore a real invariant,
 * not decoration.
 *
 * @module test/repair.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { degrade, needsThinking, offenders, repair, synthesize } from '../lib/index.js'
import { assistantTurn, deepFrozen, mixedHistory, reasoningTurn, toolResult, userMessage } from './harness.mjs'

const PLACEHOLDER = 'stand-in reasoning'

describe('the predicate', () => {
  it('matches an assistant turn with a tool call and no reasoning block', () => {
    assert.equal(needsThinking(assistantTurn('a1')), true)
  })

  it('does not match a text-only assistant turn', () => {
    assert.equal(needsThinking({ id: 'a2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'hi' }] }), false)
  })

  it('does not match a turn that already carries reasoning', () => {
    assert.equal(needsThinking(reasoningTurn('a3')), false)
  })

  it('does not match a tool result or a user message', () => {
    assert.equal(needsThinking(toolResult('a1')), false)
    assert.equal(needsThinking(userMessage()), false)
  })

  it('does not match an assistant turn with an empty reasoning block', () => {
    // An empty block is a different defect with its own guard (#9239); this
    // predicate must not claim it, or two plugins would rewrite one turn.
    const empty = { id: 'a4', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: '' }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] }
    assert.equal(needsThinking(empty), false)
  })
})

describe('synthesis', () => {
  it('puts the block first, before text and tool calls', () => {
    const repaired = synthesize(assistantTurn('a1'), PLACEHOLDER)
    assert.equal(repaired.content[0].type, 'reasoning')
    assert.equal(repaired.content[0].text, PLACEHOLDER)
    assert.equal(repaired.content[1].type, 'text')
  })

  it('keeps the turn identity and every existing block', () => {
    const original = assistantTurn('a1', 2)
    const repaired = synthesize(original, PLACEHOLDER)
    assert.equal(repaired.id, 'a1')
    assert.equal(repaired.content.length, original.content.length + 1)
    assert.deepEqual(repaired.content.slice(1), original.content)
  })

  it('leaves the caller\'s message untouched', () => {
    const original = assistantTurn('a1')
    const before = JSON.stringify(original)
    synthesize(original, PLACEHOLDER)
    assert.equal(JSON.stringify(original), before)
    assert.equal(original.content[0].type, 'text')
  })
})

describe('repair over a request', () => {
  it('reports nothing to do for a history that already round-trips', () => {
    const options = mixedHistory({ messages: [userMessage(), reasoningTurn('a9'), toolResult('a9')] })
    const report = repair(options, PLACEHOLDER)
    assert.equal(report.options, undefined)
    assert.equal(report.repaired, 0)
    assert.deepEqual(report.turns, [])
  })

  it('rewrites only the turns that need it and passes the rest by reference', () => {
    const options = mixedHistory()
    const report = repair(options, PLACEHOLDER)
    assert.notEqual(report.options, undefined)
    assert.equal(report.repaired, 1)
    assert.equal(report.turns.length, 1)
    assert.equal(report.turns[0].id, 'a1')
    assert.equal(report.turns[0].calls, 1)
    const messages = report.options.messages
    // identity, not deep equality: an untouched message must not be copied
    assert.equal(messages[0], options.messages[0])
    assert.equal(messages[2], options.messages[2])
    assert.equal(messages[3], options.messages[3])
    assert.notEqual(messages[1], options.messages[1])
    assert.equal(messages[1].content[0].type, 'reasoning')
  })

  it('leaves the original request and its messages untouched', () => {
    const options = mixedHistory()
    deepFrozen(options)
    const before = structuredClone(options)
    const report = repair(options, PLACEHOLDER)
    assert.notEqual(report.options, undefined)
    assert.deepEqual(structuredClone(options), before)
    assert.equal(options.messages[1].content[0].type, 'text')
  })

  it('does not freeze a hand-built caller\'s messages', () => {
    // A hand-built request owns its inputs until the stream settles; freezing
    // them here would be a side effect the caller never asked for.
    const options = mixedHistory()
    repair(options, PLACEHOLDER)
    assert.equal(Object.isFrozen(options.messages[0]), false)
    assert.equal(Object.isFrozen(options.messages[1]), false)
  })

  it('repairs every offending turn in a long mixed history', () => {
    const options = mixedHistory({
      messages: [userMessage(), assistantTurn('a1'), toolResult('a1'), userMessage(), assistantTurn('a2', 3), toolResult('a2')],
    })
    const report = repair(options, PLACEHOLDER)
    assert.equal(report.repaired, 2)
    assert.deepEqual(offenders(options).map(turn => turn.id), ['a1', 'a2'])
    assert.equal(report.options.messages[4].content[0].type, 'reasoning')
  })

  it('copies the request rather than replacing the object in place', () => {
    const options = mixedHistory()
    const report = repair(options, PLACEHOLDER)
    assert.notEqual(report.options, options)
    assert.equal(report.options.provider, options.provider)
    assert.equal(report.options.model, options.model)
  })

  it('carries unrelated request fields through', () => {
    const options = { ...mixedHistory(), temperature: 0.4, maxTokens: 512, stop: ['END'] }
    const report = repair(options, PLACEHOLDER)
    assert.equal(report.options.temperature, 0.4)
    assert.equal(report.options.maxTokens, 512)
    assert.deepEqual(report.options.stop, ['END'])
  })
})

describe('degrade', () => {
  it('turns reasoning off and keeps the history as recorded', () => {
    const options = mixedHistory()
    const degraded = degrade(options)
    assert.equal(degraded.reasoningEffort, 'off')
    assert.equal(degraded.messages, options.messages)
    assert.equal(degraded.messages[1].content[0].type, 'text')
  })

  it('has nothing to do when reasoning is already off', () => {
    assert.equal(degrade(mixedHistory({ reasoningEffort: 'off' })), undefined)
  })

  it('leaves the caller\'s request untouched', () => {
    const options = mixedHistory({ reasoningEffort: 'high' })
    degrade(options)
    assert.equal(options.reasoningEffort, 'high')
  })
})
