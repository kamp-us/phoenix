# Why Pi refuses a mid-turn prompt — investigation for #8214

**Date:** 2026-09-07 · **Issue:** [#8214](https://github.com/kamp-us/phoenix/issues/8214) ·
**Milestone:** Tuval first slice (#52)

Point-in-time. Source read at `apps/tuval` on `main` at `ab17cdab5e`; dependency claims read from
the pinned `@earendil-works/*` 0.84.3 trees in this clone's `node_modules`, never from the 0.85.1
line (that upgrade is epic [#8518](https://github.com/kamp-us/phoenix/issues/8518) and is not this).

The reproduction is committed beside the code it describes, as
[`apps/tuval/src/pi/ai-agent/mid-turn-refusal.unit.test.ts`](../apps/tuval/src/pi/ai-agent/mid-turn-refusal.unit.test.ts).
Six cases, no model spend, no socket.

## The short version

```
turn A running ──► A's end pushed ──► core: ready ──► operator sends B ──► core: prompting
                                                                             │
                          A's *other* frame (the answer) arrives here ───────┘
                                            │
                                            ▼
                          projection folds stale idle ──► second "ready"
                                            │
                                            ▼
                     core is ready while Pi runs B ──► operator sends C ──► Pi refuses C
```

The core's phase and Pi's phase disagree because one turn's end reaches the projection **twice**,
and the second arrival lands after a later send has already walked the projection back to
`prompting`.

## Reproduces, on current source

`PiAiAgent`'s `follow` folds two things through one queue: the server's snapshot pushes and the
snapshot each `pi.prompt` answer carries. `SnapshotProjection` (`pi/ai-agent/items.ts`) holds
`items`, `usage` and `phase` — **no `revision`** — so `eventsOf` has nothing to compare a snapshot
against and folds every arrival as current. `SessionSnapshot` does carry `revision` on the wire
(`pi-protocol` `SessionSnapshotSchema`, and `pi/server/snapshots.ts` fills it); only the projection
ignores it.

The event order that produces the disagreement, all three cases in the committed test:

| Schedule | Sent in the gap? | Second `ready`? |
|---|---|---|
| A's push, then B's send, then A's answer | yes | **yes** |
| A's answer, then B's send, then A's push | yes | **yes** |
| A's push, then A's answer, nothing sent | no | no |

**The variable is the send, not the order of the pair.** #8183's folded comment reads the push-first
schedule as the failure and answer-first as the control; the control does not hold. Whichever of a
turn's two frames lands *after* the next send's `sent` mark re-folds a stale `idle` over a
`prompting` projection, and the difference is emitted as `ready`. Answer-first is a different
arrival order, not a protective one.

With nothing sent in the gap the same late frame is worth no event, which is the case
`turn-end.unit.test.ts` already pins — that test passes and always did, because it has no send in
the gap.

## The trace, both cases

**A normal turn.** Core admits at `ready`, walks itself to `prompting`, `PiAiAgent.prompt` offers
`{_tag: "sent"}` onto the fold queue and forks `pi.prompt`. The `sent` mark emits `prompting`, the
core marks the oldest unstarted send `running` (`core/sends.ts` `markTurnRunning`). The turn's end
arrives once — push and answer carry the same revision, and the second is a no-op difference — the
core folds `ready` and `settleAccepted` accepts the oldest running send.

**The failing case.** Same up to turn A's end. Then:

1. B admitted at `ready`; `sent` mark → projection `prompting`; core marks B `running`.
2. A's late frame folds → `ready`. The core folds it and `settleAccepted` accepts **B**, whose text
   Pi is at that moment still running. Truthful in outcome (B did cross) but reached early.
3. Core phase is `ready` under a live turn. C is admitted rather than queued — `core/machine.ts`'s
   `prompt` cell queues only at `phase === "prompting"`.
4. `AgentSessionHost` calls `session.prompt(text, {expandPromptTemplates: false})`. `AgentSession`
   is streaming, no `streamingBehavior` was passed, and it throws
   (`pi-coding-agent/dist/core/agent-session.js:836`).
5. The refusal comes back as `ProtocolRefused` → `PromptError{reason: "refused"}`
   (`pi/ai-agent/refusals.ts`), rides the event stream as a keyless `failure`, and
   `settleFailedTurn` attributes it by order: B is already `accepted`, so `runningSend` is C. **The
   right key is settled.**

## The original report's "the message vanishes" no longer holds

`readHeld` (`shell/chat/outgoing.ts`) turns a `refused` outcome into an `UnsentMessage`, and
`UnsentMessages.tsx` renders it above the composer in `ChatWindow` with a Restore. The window that
sent C holds C's copy under C's key until the outcome lands, and a `refused` outcome is exactly the
one that surfaces it. So C's text is recoverable today. What is *not* fixed is that the send is
refused at all, and that the phase line reads `ready` while the agent is working.

## What could carry `streamingBehavior`, and what each would cost

The error names an option on the **SDK**, and the SDK is not the wire.

- **`@earendil-works/pi-protocol@0.84.3`'s `PromptCommandSchema` is
  `StrictObject({command, sessionId, text})`** — `additionalProperties: false` (`dist/schemas.js:5`,
  `:260`). A prompt frame carrying `streamingBehavior` is refused by `parseClientMessage` before it
  reaches any session. The committed test asserts both arms. **The remedy cannot ride the pinned
  prompt command.** The protocol package is already patched in this repo (ADR 0364), but that patch
  is a codec-compilation speed fix; widening a schema is a different order of change.
- **`AgentSessionHost` (`handleOf().prompt`)** — the one place Pi's own types live. It can pass
  `streamingBehavior` on `PromptOptions` with no wire change at all, either as a constant or as a
  decision read off `session.isStreaming`. Cheapest boundary by a distance.
- **`dispatch.ts`'s `case "prompt"`** — could route to `handle.steer` when the session is streaming.
  Also no wire change; `steer` is already a wire command and already on `PiSessionHandle`.
- **`PiSessionHandle` gaining `followUp`** — the SDK has `followUp()` and `getFollowUpMessages()`,
  but `SessionSnapshotSchema` projects `queuedSteer`/`queuedSteerCount` and **nothing for follow-ups**.
  A follow-up queued at Pi would be invisible to every Tuval surface and cancellable from none. Making
  it visible means widening a vendored strict schema.
- **The core (`core/machine.ts` / `core/queue.ts`)** — could stop admitting on a `ready` it cannot
  trust. That is a fix for the disagreement rather than for its symptom.

## Recommendation

Two bounded repairs, in this order. Neither picks `steer` over `followUp`.

**R1 — drop the stale snapshot (fixes the cause).** Carry the last folded `revision` on
`SnapshotProjection` and ignore a snapshot at or below it. The field is already on the wire and
already filled by the server, so this is a projection change with no protocol surface. Regression
cases: the two failing schedules in the committed test flip to "no second ready"; the third and
`turn-end.unit.test.ts`'s two cases stay green (a resume seeds the projection off `heldSnapshot`,
so the seed's revision has to seed the comparison too, or the first push after a reattach is
dropped).

**R2 — make the refusal impossible rather than unlikely (defence in depth).** Pass a
`streamingBehavior` from `AgentSessionHost`, so a send that still races loses nothing. Regression
case: a `PiSessionHost` fake whose session reports streaming takes the prompt instead of refusing.

R1 alone leaves a narrower race (the core's `ready` is still a moment old when the operator sends).
R2 alone leaves the phase line lying to the operator. R1 without R2 is the honest minimum.

## The decision this leaves for a human

**Which behaviour does a raced mid-turn send take — `steer` or `followUp` — and does Tuval keep two
queues?**

Not answerable from the source, and R2 cannot land without it:

- `steer` interrupts the running turn with the operator's text. Already projected on the wire
  (`queuedSteer`), already on `PiSessionHandle`, already dispatchable. Visible and cancellable.
- `followUp` waits for the turn to end. Matches what `core/queue.ts` already promises an operator,
  and duplicates it: the text would then be queued at Pi, invisible to the window, outside the
  core's `queueLimit`, and released by nothing when the session is abandoned — which is the exact
  failure ADR 0357 and #8159 built the core queue to end.
- The third answer is "neither": fix R1, keep one queue in the core, and let a raced send stay a
  refusal the window offers back.

#8159's author owns this one. Nothing in this investigation selects it.
