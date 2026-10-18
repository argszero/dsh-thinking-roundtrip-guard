/**
 * Defect injection: does the suite actually observe each promise the plugin makes?
 *
 * A green suite is evidence only if a broken implementation makes it red. This
 * script mutates the **shipped artifact** (`lib/*.js`, the files a consumer
 * installs) one plausible defect at a time, runs the suite, and restores the file.
 *
 * Mutating the artifact rather than `src/` is deliberate: the artifact is what a
 * user runs, so the measurement is on the shipped bytes, and it also sidesteps the
 * question of whether a mutant would even typecheck — a mutant that does not build
 * measures nothing. Every replacement below is syntactically valid JavaScript,
 * which the run itself proves (a syntax error fails the suite for the wrong
 * reason, so an arm reporting a *compile* failure is reported as BROKEN, not
 * CAUGHT).
 *
 * An arm that leaves the suite green is reported SILENT: either the promise is not
 * tested, or the mutation is equivalent. Equivalent mutants are named in the
 * EQUIVALENT list instead of being run.
 *
 * Usage: node scripts/inject-defects.mjs [--only <id>]
 *
 * @module @argszero/dsh-thinking-roundtrip-guard/scripts/inject-defects
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Mutants named but not run, with the reason the suite cannot distinguish them.
 *
 * Empty, and that is a measured statement rather than an assumption: the two
 * candidates this list first carried — "return a replacement even when nothing
 * needed repair" and "drop one counter increment" — were reasoned to be
 * unobservable and both turned out to be CAUGHT when actually run. Reasoning about
 * equivalence is how a mutant gets excused instead of measured, so an arm is only
 * listed here if the run itself showed it cannot be told apart, which so far is
 * none.
 * @type {readonly {id: string, file: string, why: string}[]}
 */
const EQUIVALENT = []

/** @type {readonly {id: string, file: string, find: string, replace: string, breaks: string}[]} */
const ARMS = [
  {
    id: 'A1',
    file: 'lib/repair.js',
    find: 'if (!blocks.some(block => block.type === TOOL_CALL))\n        return false;\n    return !blocks.some(block => block.type === REASONING);',
    replace: 'return !blocks.some(block => block.type === REASONING);',
    breaks: 'the predicate claims text-only assistant turns, which the endpoint accepts without a thinking block',
  },
  {
    id: 'A2',
    file: 'lib/repair.js',
    find: 'return !blocks.some(block => block.type === REASONING);',
    replace: 'return true;',
    breaks: 'a turn that already recorded its reasoning gets a second block',
  },
  {
    id: 'A3',
    file: 'lib/repair.js',
    find: 'const content = Object.freeze([{ type: REASONING, text: placeholder }, ...message.content]);',
    replace: 'const content = Object.freeze([...message.content, { type: REASONING, text: placeholder }]);',
    breaks: 'the thinking block is appended after text and tool calls instead of leading them',
  },
  {
    id: 'A4',
    file: 'lib/repair.js',
    find: 'messages.push(synthesize(message, placeholder));\n        repaired += 1;',
    replace: 'messages.push(message);\n        repaired += 1;',
    breaks: 'the turn is counted as repaired but the block is never inserted',
  },
  {
    id: 'A5',
    file: 'lib/repair.js',
    find: 'if (options.reasoningEffort === \'off\')\n        return undefined;\n    return Object.freeze({ ...options, reasoningEffort: \'off\' });',
    replace: 'return Object.freeze({ ...options });',
    breaks: 'the degraded request carries no reasoning change, so it is the same request that just failed',
  },
  {
    id: 'A6',
    file: 'lib/outbound.js',
    find: 'return providers.length === 0 || providers.includes(provider);',
    replace: 'return true;',
    breaks: 'the allowlist is ignored and every route is rewritten',
  },
  {
    id: 'A7',
    file: 'lib/outbound.js',
    find: 'if (options.reasoningEffort === \'off\')\n                return next();',
    replace: '',
    breaks: 'a request that states reasoning off still gets a thinking block inserted',
  },
  {
    id: 'A8',
    file: 'lib/outbound.js',
    find: 'return /thinking/i.test(failure.message);',
    replace: 'return true;',
    breaks: 'every 400 is treated as the thinking rejection, including content moderation',
  },
  {
    id: 'A9',
    file: 'lib/outbound.js',
    find: 'if (chunk.type === \'finish\' && !visible && isThinkingRejection(chunk.reason)) {',
    replace: 'if (chunk.type === \'finish\' && isThinkingRejection(chunk.reason)) {',
    breaks: 'a rejection is retried after visible output was already forwarded to the caller',
  },
  {
    id: 'A10',
    file: 'lib/outbound.js',
    find: 'policy.onEscalate(chunk.reason.failure);\n                    yield* alternative;\n                    return;',
    replace: 'policy.onEscalate(chunk.reason.failure);\n                    yield chunk;\n                    yield* alternative;\n                    return;',
    breaks: 'the withheld failure frame leaks to the caller ahead of the retry\'s own outcome',
  },
  {
    id: 'A11',
    file: 'lib/outbound.js',
    find: 'const degraded = degrade(options);\n                if (degraded === undefined)\n                    return undefined;',
    replace: 'const degraded = degrade(report.options);\n                if (degraded === undefined)\n                    return undefined;',
    breaks: 'the retry is built from the repaired history, which carries the block a thinking-off route does not want',
  },
  {
    id: 'A12',
    file: 'lib/outbound.js',
    find: 'if (!settings.escalate)\n                return first;',
    replace: 'if (true)\n                return first;',
    breaks: 'the escalation is never installed, so a rejected repair fails the turn',
  },
  {
    id: 'A13',
    file: 'lib/repair.js',
    find: 'if (repaired === 0)\n        return { options: undefined, turns, repaired };',
    replace: 'if (repaired === 0)\n        return { options: Object.freeze({ ...options, messages: Object.freeze(messages) }), turns, repaired };',
    breaks: 'a history with nothing to repair is still reported (and re-dispatched) as a repair',
  },
  {
    id: 'A14',
    file: 'lib/index.js',
    find: 'counters.turnsRepaired += turns.length;',
    replace: '',
    breaks: 'the read-only view under-reports how many turns were repaired',
  },
]

/**
 * Replace exactly one occurrence, refusing when the anchor is not found exactly
 * once — an arm that silently matched nothing would report a false SILENT.
 * @param {string} file - path relative to the package root.
 * @param {string} find - the exact text to replace.
 * @param {string} replace - what to put there.
 * @returns {string} the original file content, for restoration.
 */
function mutate(file, find, replace) {
  const path = join(ROOT, file)
  const before = readFileSync(path, 'utf8')
  const count = before.split(find).length - 1
  if (count !== 1) throw new Error(`${file}: anchor matched ${count} times, expected exactly 1`)
  writeFileSync(path, before.replace(find, replace))
  return before
}

/**
 * Run the suite and report whether it failed.
 * @returns {{status: 'CAUGHT'|'SILENT'|'BROKEN', detail: string}}
 */
function runSuite() {
  const result = spawnSync(process.execPath, ['--test', 'test/'], { cwd: ROOT, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const summary = /# fail (\d+)/.exec(output) ?? /ℹ fail (\d+)/.exec(output)
  if (result.status === 0) return { status: 'SILENT', detail: 'suite green' }
  if (summary !== null && Number(summary[1]) > 0) return { status: 'CAUGHT', detail: `${summary[1]} test(s) failed` }
  return { status: 'BROKEN', detail: 'the suite did not run to a verdict' }
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined

let survived = 0
for (const arm of ARMS) {
  if (only !== undefined && arm.id !== only) continue
  const original = mutate(arm.file, arm.find, arm.replace)
  try {
    const verdict = runSuite()
    if (verdict.status !== 'CAUGHT') survived += 1
    console.log(`${verdict.status.padEnd(7)} ${arm.id}  ${arm.file}  ${verdict.detail} — breaks: ${arm.breaks}`)
  } finally {
    writeFileSync(join(ROOT, arm.file), original)
  }
}

console.log(`\n${ARMS.length - survived}/${ARMS.length} arms caught; ${EQUIVALENT.length} equivalent arms named and not run:`)
for (const arm of EQUIVALENT) console.log(`  EQUIVALENT ${arm.id}  ${arm.file} — ${arm.why}`)
process.exitCode = survived === 0 ? 0 : 1
