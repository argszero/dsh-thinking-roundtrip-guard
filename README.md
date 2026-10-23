# @argszero/dsh-thinking-roundtrip-guard

A mixed-provider session stops being a one-way door.

Source discussion: [deepseek-ai/deepseek-harness#10077](https://github.com/deepseek-ai/deepseek-harness/discussions/10077).

## The gap

On a Messages-shaped route with thinking enabled, the endpoint requires **every
historical assistant turn that carries a tool call** to carry a thinking block too.
Its own words:

> The `content[].thinking` in the thinking mode must be passed back to the API.

dsh's serializer emits a thinking block only where the durable message already
holds a `reasoning` block (`packages/llm/llm-deepseek/src/serialize.ts`, the
`case 'reasoning'` arm). A turn produced on a **different** route — a pi-ai route,
another dialect — is durable as text plus a tool call and no reasoning block at
all. So the moment a session mixes routes, switching back leaves turns the
endpoint refuses, and because the history is append-only the refusal repeats on
**every** later request, including a plain-text follow-up. That session can never
use the route again.

## What this plugin does

It repairs the **outbound** request at the `llm/stream` waterfall — the one seam
every model call crosses — and leaves the durable session log untouched.

| mode | what is sent |
|---|---|
| `synthesize` (default) | the same history, with a placeholder thinking block inserted **ahead of** each tool-carrying turn that had none |
| `degrade` | the same history with reasoning effort `off` — the shape a thinking-disabled route accepts |
| `observe` | nothing; it counts what `synthesize` would repair |
| `off` | nothing, and no listener installed |

`synthesize` is the default because a signature is not what the endpoint asks for:
the reporter measured the live endpoint, and a thinking block **without** a
signature answers `200`, with a signature `200`, and the same turn without one
`400`. In this repository a `ReasoningBlock` is `{ type, text }` — the signature
lives beside it in the replay envelope — so a signature-less reasoning block is a
shape the durable model already allows and the serializer already sends.

Because a synthesized block is still a claim about a turn this process did not
produce, `synthesize` also reads the response: a rejection that arrives **before
any visible output** is withheld, and the *original* history is retried with
reasoning off. If the retry fails too, the retry's own failure is what the caller
sees — exactly one terminal frame, never the discarded attempt's.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/dsh-thinking-roundtrip-guard
```

The git form is the only form there is right now: the npm name is not published,
so `dsh plugin add @argszero/dsh-thinking-roundtrip-guard` fails with `E404`. A
plain `npm install` of the same git spec only places the files; `dsh plugin add`
is the step that mounts it in the profile.

Mount it in a profile entry:

```yaml
- name: '@argszero/dsh-thinking-roundtrip-guard'
  config:
    mode: synthesize          # synthesize | degrade | observe | off
    providers:                # default: ['deepseek-official']
      - deepseek-official
```

Ask it what it has done:

```ts
ctx.get('thinkingRoundtripGuard')?.snapshot()
// { mode, providers, escalate, requestsRepaired, turnsRepaired,
//   requestsObserved, requestsDegraded, escalations, errors, notes, blindSpots }
```

### Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `synthesize` | see the table above |
| `providers` | `['deepseek-official']` | route names the plugin may touch; an empty list means every route |
| `placeholder` | a sentence saying the reasoning was not recorded | text of the synthesized block; must be non-empty (an empty thinking block is a different rejection, #9239) |
| `escalate` | `true` | retry with reasoning off when a repaired request is rejected before any visible output |
| `report` | `true` | log the mount summary at `info`, one line per repair at `debug` |

A configuration value that is not usable never stops the mount: it falls back to
the default and is reported by name in `snapshot().notes`.

## What it does not claim

- **The core fix is not this.** The right place is the serializer or the request
  assembly, where the route's own thinking policy is known — a plugin cannot see a
  connection's defaults. Until then this keeps the session usable.
- **The durable session log is untouched.** The repair exists in the request this
  process sends; revoking the plugin revokes the repair, and nothing an operator
  wrote is rewritten in place.
- **A rejection worded without "thinking" is not classified.** Reacting to every
  `400` would hide a content rejection or an exhausted window behind a degraded
  retry that cannot help. Where the wording differs, `mode: 'degrade'` is the
  deterministic escape: it reads nothing.
- **Tool-call pairing is not touched.** The serializer's local `INVALID_REQUEST`
  precheck owns that.

`snapshot().blindSpots` states all of the above on every read.

## Verification

- `npm test` — 52 assertions on a real cordis context and the real `llm/stream`
  waterfall, with a probe standing in for the adapter. The control arm (no plugin)
  shows the request an adapter gets today.
- `node scripts/inject-defects.mjs` — 14 plausible defects injected into the
  **shipped** `lib/`, one at a time: **14/14 caught**, none excused as equivalent.

Zero runtime dependencies; `@deepseek-ai/cordis` and `@deepseek-ai/dsh-llm` are
peers, resolved from the host.

## License

MIT
