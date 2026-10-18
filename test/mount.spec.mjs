/**
 * Mounting: the shape a loader sees, the read-only view an operator reads, and
 * the configuration values that are refused rather than obeyed.
 *
 * @module test/mount.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as plugin from '../lib/index.js'
import { DEFAULT_PLACEHOLDER } from '../lib/index.js'
import { world, mixedHistory } from './harness.mjs'

describe('what a loader mounts', () => {
  it('exports a default with name, inject and apply', () => {
    assert.equal(typeof plugin.default, 'object')
    assert.equal(typeof plugin.default.name, 'string')
    assert.deepEqual(plugin.default.inject, ['llm'])
    assert.equal(typeof plugin.default.apply, 'function')
  })

  it('exports no Config key', () => {
    // A plain defaults object has no `~standard`, and a mounted plugin whose
    // `Config` lacks one dies before `apply` runs.
    assert.equal('Config' in plugin, false)
    assert.equal('Config' in plugin.default, false)
  })

  it('mounts through the default export', async () => {
    const h = await world({ plugin: 'default' })
    assert.notEqual(h.snapshot(), undefined)
    assert.equal(h.snapshot().mode, 'synthesize')
  })
})

describe('the read-only view', () => {
  it('reports the resolved defaults', async () => {
    const h = await world()
    const snapshot = h.snapshot()
    assert.equal(snapshot.mode, 'synthesize')
    assert.deepEqual(snapshot.providers, ['deepseek-official'])
    assert.equal(snapshot.escalate, true)
    assert.equal(snapshot.requestsRepaired, 0)
    assert.equal(snapshot.turnsRepaired, 0)
    assert.equal(snapshot.escalations, 0)
    assert.equal(snapshot.errors, 0)
    assert.deepEqual(snapshot.notes, [])
  })

  it('states its blind spots on every read', async () => {
    const h = await world()
    const { blindSpots } = h.snapshot()
    assert.ok(blindSpots.length >= 4)
    assert.ok(blindSpots.some(spot => spot.includes('thinking default')))
    assert.ok(blindSpots.some(spot => spot.includes('durable session log')))
  })

  it('is still provided when the mode is off', async () => {
    const h = await world({ config: { mode: 'off' } })
    assert.equal(h.snapshot().mode, 'off')
  })
})

describe('mode off', () => {
  it('installs no listener', async () => {
    const h = await world({ config: { mode: 'off' } })
    await h.stream(mixedHistory())
    assert.equal(h.seen[0].messages[1].content[0].type, 'text')
    assert.equal(h.snapshot().requestsRepaired, 0)
  })
})

describe('configuration values that are refused', () => {
  it('falls back on an unknown mode and says so', async () => {
    const h = await world({ config: { mode: 'repair-everything' } })
    const snapshot = h.snapshot()
    assert.equal(snapshot.mode, 'synthesize')
    assert.equal(snapshot.notes.length, 1)
    assert.ok(snapshot.notes[0].includes('repair-everything'))
  })

  it('drops a non-string provider and says so', async () => {
    const h = await world({ config: { providers: ['deepseek-official', 7, ''] } })
    const snapshot = h.snapshot()
    assert.deepEqual(snapshot.providers, ['deepseek-official'])
    assert.equal(snapshot.notes.length, 2)
  })

  it('de-duplicates repeated provider names', async () => {
    const h = await world({ config: { providers: ['a', 'a', 'b'] } })
    assert.deepEqual(h.snapshot().providers, ['a', 'b'])
  })

  it('refuses an empty placeholder and uses the default text', async () => {
    const h = await world({ config: { placeholder: '' } })
    assert.equal(h.snapshot().notes.length, 1)
    await h.stream(mixedHistory())
    assert.equal(h.seen[0].messages[1].content[0].text, DEFAULT_PLACEHOLDER)
  })

  it('refuses a non-boolean escalate flag', async () => {
    const h = await world({ config: { escalate: 'yes' } })
    assert.equal(h.snapshot().escalate, true)
    assert.equal(h.snapshot().notes.length, 1)
  })

  it('still mounts when every value is wrong', async () => {
    const h = await world({ config: { mode: 3, providers: 'deepseek', placeholder: 5, escalate: null, report: 'on' } })
    const snapshot = h.snapshot()
    assert.equal(snapshot.mode, 'synthesize')
    assert.deepEqual(snapshot.providers, ['deepseek-official'])
    assert.ok(snapshot.notes.length >= 4)
  })
})
