---
id: 0364
title: "`@earendil-works/pi-protocol` compiles its typebox validators once, carried as a local patch until upstream takes it"
status: superseded by [0366](0366-tuval-keeps-own-pi-host.md)
date: 2026-09-07
tags: [tuval, dependencies, performance, pi]
---

# 0364 — `@earendil-works/pi-protocol` compiles its typebox validators once, carried as a local patch until upstream takes it

**What this decides:** phoenix patches its pinned `@earendil-works/pi-protocol` so the Pi wire codec
builds each message validator once instead of re-walking the schema on every message, and offers the
same change upstream rather than routing around the codec in our own code.

## Context

Streaming a Pi reply in the Tuval desk crawled, and the desk's node process sat at 100% CPU for the
whole turn ([#8515](https://github.com/kamp-us/phoenix/issues/8515)).

The cost is in the dependency, not in Tuval. `@earendil-works/pi-protocol@0.84.3`'s
`dist/codec.js` calls `Check(ServerMessageSchema, value)` from `typebox/value` on every encode
(`parseServerMessage`, reached from `encodeProtocolMessage`) and again on every decode
(`ValidatedMessageDecoder.push`). `Check` is typebox's interpreted path: it re-walks the schema per
call and nothing is cached. `dist/schemas.js` then declares `JsonValueSchema` as a
`Type.Cyclic({JsonValue: Type.Union([… Type.Array(Type.Ref("JsonValue")),
Type.Record(Type.String(), Type.Ref("JsonValue"))])})`, and that cyclic `$ref` is re-resolved per
node. A tool item's `input` and `details` are that schema, so every tool call in a transcript pays
for the whole walk.

Measured against this repo's pins (`typebox@1.3.7`, node 26), one `Check` call on a
`session_snapshot`:

| message | JSON size | uncompiled `Check` | compiled `Check` |
|---|---|---|---|
| 1 item | 0.5 KB | 0.069 ms | 0.004 ms |
| 32 items (16 tool calls) | 21 KB | 563 ms | 0.14 ms |
| 100 items (50 tool calls) | 63 KB | 1791 ms | 0.45 ms |
| 300 items (150 tool calls) | 184 KB | 5218 ms | 0.69 ms |
| 300 items, text only | 178 KB | 15 ms | 0.21 ms |

The text-only row is what names the cause: ~35 ms per tool item and near zero per text item, so the
cost is the cyclic `JsonValue` `$ref` and nothing else.

Building the validators is the other side of the ledger, and the two directions are nothing like
each other: `Compile(ServerMessageSchema)` costs ~170 ms, `Compile(ClientMessageSchema)` ~0.5 ms.
That asymmetry follows from the schemas — the server union carries the whole transcript vocabulary
and the client union carries a handful of small commands.

Tuval pays that twice per message. `PiServerService.ts`'s `followSession` writes a whole
`session_snapshot` — `snapshots.ts`'s `sessionSnapshot` carries `transcript: [...view.transcript]`
— every time the session handle signals a change, and a streamed turn signals on every delta. The
Pi server and the Pi client both live inside the desk process, so each snapshot is validated once on
the way out and once on the way in. On a 300-item transcript that is about 10 s of validation CPU
per snapshot, which is why the process pins rather than merely lagging.

Nothing in phoenix's own code can avoid it. Both ends of the socket run the dependency's validator,
and the protocol's own refusal semantics are what that validator is for — declining to validate
would be a different decision about the wire, not a performance fix.

## Decision

**`@earendil-works/pi-protocol@0.84.3` is patched in-repo so `parseClientMessage` and
`parseServerMessage` each use a validator built once with `Compile` from `typebox/compile`, and the
same change is offered upstream to `earendil-works/pi`.**

The patch lives at `patches/@earendil-works__pi-protocol@0.84.3.patch`, wired through
`patchedDependencies` in `pnpm-workspace.yaml`. It touches one file and adds no behaviour of its
own: the `typebox/value` import becomes `typebox/compile`, and the two `Check(Schema, value)` calls
become `.Check(value)` on a lazily built, memoized validator.

**Lazy rather than eager**, because of the asymmetry above: eager would make every process that
speaks only the client direction pay the server union's ~170 ms for a validator it never calls. The
desk speaks both, so it pays both — ~170 ms once, at the first message of each direction, against
seconds per message saved.

**Equivalence was checked, not assumed.** The compiled and uncompiled validators agree on all 13
cases exercised before the patch was committed: valid snapshots with and without a transcript, an
unknown top-level type, an extra property, a missing required field, a wrong-typed field, an empty
`minLength: 1` id, a negative timestamp, a status off its union, a deep `JsonValue`, an `undefined`
inside a `JsonValue`, a thinking level off its union, and a streaming item carrying a `stopReason`
its variant forbids. The patch is a speed change, not a laxity change.

Round trip through the real codec (`encodeServerMessage` then `ServerMessageDecoder.push`), which is
the pair of `Check` calls the desk actually pays per snapshot:

| transcript | unpatched | patched |
|---|---|---|
| 1 item | 0.88 ms | 0.15 ms |
| 51 items (25 tool calls) | 2114 ms | 1.32 ms |
| 301 items (150 tool calls) | 10444 ms | 5.93 ms |

The patch is held the way every maintained patch here is held, in the two layers
[`.patterns/dependency-patch-behavior-pins.md`](../.patterns/dependency-patch-behavior-pins.md)
defines and `fabrika guard patch-guard check` fails closed on: the version-keyed
`patchedDependencies` entry, which is pnpm's own loud-fail on version drift, and a behavior pin —
`apps/tuval/src/pi/codec-compiled-check.unit.test.ts`, carrying the
`// @patch-pin: @earendil-works/pi-protocol@0.84.3` marker. That pin asserts both halves: a
300-item round trip under a 1 s ceiling (three orders of magnitude above the patched cost and three
below the unpatched one, so no machine's speed moves the verdict), and that the codec still refuses
a message the schema does not admit — speed alone would pass on a codec that validated nothing.

**Binding constraints.**

- Re-key this patch on the next `@earendil-works/pi-protocol` bump — both layers, the
  `patchedDependencies` key and the `@patch-pin` marker — and drop it once a release makes it
  pointless.
- **0.85.1 is that release, and phoenix cannot take it yet.** Its `dist/codec.js` still calls the
  uncompiled `Check`, so a reader checking only that line would re-cut this patch; but the schemas
  under it were redesigned, and that is what matters. `PROTOCOL_VERSION` goes 1 → 8, `schemas.ts`
  becomes `protocol.ts`, and every payload is now `Type.Unsafe(Type.Unknown())` — validation never
  walks a transcript, so the same 300-item snapshot costs **0.110 ms** uncompiled there against
  5218 ms here. On 0.85.1 this patch buys 0.110 ms → 0.002 ms and is not worth carrying. It cannot
  simply be taken, because the same redesign removes `SessionSnapshot`, `TranscriptItem`,
  `ModelMetadata`, `ModelRef`, `ThinkingLevel`, `Command`, `CommandResult`, `ServerSnapshot` and
  `SessionMetadata` from the package entirely and renames `@earendil-works/pi-client`'s surface
  (`PiClient` → `Client`, session handles replaced by attachments and service subscriptions) —
  which `apps/tuval/src/pi` is written against across 36 files. The upgrade also pulls a runtime
  dependency 0.84.3 does not carry: 0.85.1's `codec.js` imports `isJsonValue` from
  `@earendil-works/chord`. **This patch retires with the 0.85.x upgrade — dropped as part of it, not
  before it, and never re-cut against 0.85.x**, because validation there costs 0.110 ms on the
  snapshot that costs 5218 ms here, so a compiled validator would buy 0.108 ms of it.
  [#8518](https://github.com/kamp-us/phoenix/issues/8518) carries that upgrade and is where this
  patch is deleted.
- **The `@earendil-works/pi-*` family is eight entries across two mechanisms in
  `pnpm-workspace.yaml`, and a bump moves all eight.** The `catalog:` block carries four —
  `pi-ai`, `pi-client`, `pi-coding-agent`, `pi-protocol` — and `overrides:` carries four more —
  `pi-agent-core`, `pi-ai`, `pi-telemetry`, `pi-tui`. The `overrides:` block exists because the
  cataloged packages ask for their siblings by `^0.84.3`, and a caret picks the highest published
  patch: 0.84.4 put a second `@earendil-works/pi-ai` in the tree beside the cataloged one, the faux
  provider registered into one copy and the agent loop reading the other. Its own comment records
  that as a correctness hazard rather than weight, and says to re-key the whole family. Re-keying
  the catalog and leaving `overrides:` behind reproduces that duplicate with a green build, so read
  both blocks' comments before bumping. This patch is re-generated with them.
- `pnpm patch-commit` rewrites `pnpm-workspace.yaml` wholesale, stripping the catalog's comments and
  re-sorting its keys. Restore that file from `main` after committing a patch and hand-add the
  `patchedDependencies` line — the same instruction ADR
  [0361](0361-manti-menu-highlighted-value-patch.md) records.

## Consequences

The desk's per-message validation cost stops scaling with transcript length, which is the whole of
the reported slowness on a session long enough to hold tool calls.

What this does **not** fix: `followSession` still sends the entire transcript on every session
change, so a streamed turn still moves ~180 KB per delta across the loopback socket and still
rebuilds the whole snapshot object each time. The protocol already carries `item_updated` and
`assistant_delta` progress messages that would bound that work regardless of transcript length.
That is a separate decision about what Tuval's Pi server sends, and #8515 carries it.

This is [ADR 0038](0038-dependency-patches-local-only.md)'s shape — a local `pnpm patch` committed
to the repo, never an external patch source, with upstreaming encouraged and the merged release, not
the in-flight PR, as the thing phoenix eventually depends on. ADR
[0170](0170-workers-cache-via-alchemy-effect-pnpm-patch.md) and ADR
[0361](0361-manti-menu-highlighted-value-patch.md) are the same move on other pins.
