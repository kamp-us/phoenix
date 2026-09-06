---
id: 0359
title: A reply streams into one growing transcript row, and the marker on it expires with the turn
status: accepted
date: 2026-09-05
tags: [tuval, ai-agent, ux]
---

# 0359 — A reply streams into one growing transcript row, and the marker on it expires with the turn

**What this decides:** An agent's reply reaches the Tuval chat window as it is written, as one row
re-sent under one id with more text each time, marked `streaming` on the shared transcript item —
and the moment the turn ends, whichever way it ends, that marker is gone.

## Context

Every reply landed as one block at the turn's end. A two-minute turn was two minutes of a window
with nothing in it but the "Working…" line, which is the single thing that made a Tuval window worse
than the terminal it replaces; every comparable surface streams (#8160).

Neither backend was streaming, and for different reasons.

Claude *has* the stream and threw it away. `SDKPartialAssistantMessage` frames are emitted only
under `includePartialMessages` (`sdk.d.ts` at `@anthropic-ai/claude-agent-sdk@0.3.259`), the option
was never set, and `history/events.ts` fell `stream_event` through to `skipMessage` anyway. The flag
is one line; the mapping is not, because the frame's own `uuid` is fresh per delta, so a row keyed
on it is a row per token.

Pi does not have the stream at the seam at all. The in-flight reply is held aside in
`AgentState.streamingMessage` and only pushed into `messages` on `message_end` (`pi-agent-core`
`dist/agent.js`, `processEvents`) — and the loop's own partial goes into a *copy* of the message
array (`dist/agent-loop.js`, over `createContextSnapshot`), so `session.messages` never holds it.
The server projected `session.messages` alone, so a mid-turn snapshot differed from the one before
it in `phase` and `revision` and nothing else.

## Decision

**One marker on the shared item, and the turn's end is what expires it.**

`AssistantItem` becomes a two-member union in `ports/transcript-item.ts`: a `StreamingAssistantItem`
carrying `streaming: true` and no `interrupted`, and a `SettledAssistantItem` carrying `interrupted`
and no `streaming`. They are two answers to the one question a reader asks of a reply — has this
turn finished? — so an interrupt *settles* a stream rather than annotating one, and
`{streaming: true, interrupted: true}` is a sentence no producer can write. The port predicate is
the runtime half of that and refuses it.

No new event kind and no new port. A delta is an ordinary `item` event, and the fold's existing
`upsertItem` supersedes by id, so a growing reply is the send-echo join (#7978) used again.

**The join key is the backend's, and each backend already has one.**

- Claude: the *API* message id off the wrapped `BetaRawMessageStartEvent`, held in `Mapping` across
  the turn, with the row id `stream:<message id>:<block index>`. The complete `SDKAssistantMessage`
  for a block repeats that id, claims the row, and lands under it — so the finished reply replaces
  the growing one instead of landing beside it, and a turn with the flag off produces exactly what
  it produced before. Claiming is ordered per message id, because one message can stream several
  text blocks.
- Pi: the wire's own positional id. The server appends `streamingMessage` to the projection
  (`pi/server/transcript.ts`), which is the index `message_end` pushes the finished message at — so
  the partial and the reply that replaces it are one row with no join invented for them. Its
  `stopReason` is `"pending"` while it streams, which is what the projection's already-present
  `streaming` arm answers to.

**The marker is a claim about a turn that is running, so `foldEvent` clears it on every way out of
`prompting`** — ready, gone, failed. A row still `streaming` past the turn's end is a reply nobody
will finish, and it settles as `interrupted`. A backend that reports the cut itself wins, because
its item carries the streamed row's id and lands first.

**A partial never comes back from a checkpoint as a whole reply.** The store is written per fold, so
a checkpoint taken between two deltas holds a `streaming` row; `restore` settles it as `interrupted`
and points the resend affordance at it — a sharper cut test than the saved phase, which is folded by
a different event and can say anything.

**Claude's deltas are coalesced in the mapping, on the clock the layer already stamps.** Deltas
arrive per token and every fold writes the whole session state to the checkpoint store
(`host/actor.ts`), so an unthrottled stream would rewrite the transcript to disk per token. A pure
interval read off `MappingOptions.at` (`STREAM_EMIT_INTERVAL_MS`) is the coalescing; each emission
carries the whole accumulated block, so it costs latency and never text. Pi needs none of its own:
the session host already collapses a burst of events into one pending change, and the revision diff
suppresses a repaint of an unchanged projection.

## Consequences

Both windows show a reply as it is written. `#8148`'s thinking row is now free to stream on the same
marker, which was the sequencing reason it shipped collapsed-only.

A partial does still reach the checkpoint store — the debounce the epic names lives in `durability/`
and `host/`, which every Tuval program sits on, and it is its own child (#8160). What this record
buys against that is the *correctness* half: a partial that lands in a checkpoint can never come
back looking final.

The cost of the union over a second boolean is that `AssistantItem` is no longer one interface, so a
construction that widened `kind` across a ternary now has to build each arm (`service/fixtures/`).
`interrupted` keeps its shape and its meaning, so no `.tuval/` checkpoint a running desk wrote has
become unreadable.

**Grounded, not assumed.** The one fact that decided the Claude mapping is not readable off
`sdk.d.ts` and came out of a fresh golden capture
(`claude/history/fixtures/partial-assistant-turn.json`, `PROVENANCE.md`): the complete `assistant`
frame for a text block arrives **before** that block's `content_block_stop`. A mapping that settled
the row on the stop would re-open a finished reply as a partial one.

## Records

no vocabulary impact
