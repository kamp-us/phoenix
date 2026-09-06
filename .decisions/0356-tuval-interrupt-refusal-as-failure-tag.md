---
id: 0356
title: A refused interrupt reaches Tuval's core as a failure tag, never a typed error
status: accepted
date: 2026-09-06
tags: [tuval, ai-agent, interrupt, errors]
---

# 0356 — A refused interrupt reaches Tuval's core as a failure tag, never a typed error

**What this decides:** when a backend refuses to stop a running turn, Tuval's adapter puts a declared failure tag on the event stream and `TuvalAiAgent.interrupt` keeps its `Effect<void>` signature; the fold gives that tag its own phase rule instead of the walk-to-`ready` every other failure gets.

## Context

Tuval's window can say an interruption is outstanding but cannot say a backend refused one. Read at `b3a6f432` on `apps/tuval`:

- `src/ai-agent/service/TuvalAiAgent.ts` declares `readonly interrupt: Effect.Effect<void>` — no error channel.
- Both adapters therefore swallow a refusal into a log line. `src/pi/ai-agent/PiAiAgent.ts` catches `pi.abort`'s refusal into `Effect.logWarning("interrupt was refused: …")`; `src/claude/agent/ClaudeAiAgent.ts` does the same on `current.handle.interrupt()`.
- `src/ai-agent/service/errors.ts` keys one tagged class per method that raises. `interrupt` raises none, so there is no tag for the act.
- `src/ai-agent/core/fold.ts`'s `phaseAfterFailure` walks a `prompting` session to `ready` on *any* failure, which is exactly the premature readiness [#8007](https://github.com/kamp-us/phoenix/issues/8007) exists to fix.

So a refused abort and an abort still in flight are one state to the core. The operator whose abort was refused waits out the grace window and reads `interruptionLine`'s "the agent has not confirmed" (`src/shell/chat/phase.ts`) instead of being told the backend said no. That is honest and coarser than #8007's criterion 5 asked for.

Closing it needed a contract choice, because both routes widen a surface the founder fenced with "do not add a Claude-only requirement to `TuvalAiAgent`". [#8072](https://github.com/kamp-us/phoenix/issues/8072) put the two options up, and this record transcribes the founder's ruling of 2026-09-05 PT: <https://github.com/kamp-us/phoenix/issues/8072#issuecomment-5556549902>.

An earlier ruling comment on the same issue picked the other option — a typed error channel — and is superseded by the one cited above: <https://github.com/kamp-us/phoenix/issues/8072#issuecomment-5555958237>. Both remain on the issue; this record is what a builder implements.

The failure-as-data direction agrees with ADR [0346](0346-sub-failure-policy-actor-identity.md), which rules that a Sub fiber's failure becomes a plain-data Msg the reducer handles rather than something the host absorbs. Neither ADR is superseded or amended by this one.

## Decision

**A refused interrupt travels as a declared interrupt-failure tag on the event stream, put there by the adapter that was refused, and the fold gives that tag its own phase rule.**

**Route.** `interrupt` keeps `Effect.Effect<void>` in `src/ai-agent/service/TuvalAiAgent.ts`. `src/ai-agent/service/errors.ts` gains a tagged class for the interrupt act, on the same one-class-per-method shape the file already carries, and the adapter emits it as an `AgentFailure` on `events` where it currently logs a warning. The reason the founder took this over a typed error on the call: a tag on the stream reaches the fold, the checkpoint and the restore, so a window restored after a restart still sees the refusal. A typed error on the call reaches only the caller of that call.

**Phase.** `phaseAfterFailure` does not decide this one. The fold routes the interrupt tag on its own, in two halves:

- **Refused while the turn is still running** — the phase stays `prompting`, and the window reads that the backend refused to stop rather than that it has not confirmed.
- **Refused because there is no live turn** — no subprocess, or the turn is already gone. The session records the cut-short turn and moves to `ready`. This is the case that froze the founder's desk on 2026-09-05 at 19:09 PT with `interrupt was refused: Operation aborted`.

**Adapters.** Each adapter emits the tag when its own backend refuses. An adapter with no refusal path emits nothing, and that is not a gap — it is the fence holding. Nothing here is required of a backend that cannot refuse.

**Binding constraints.**

- `TuvalAiAgent.interrupt`'s signature stays `Effect.Effect<void>`. Giving it an error channel is the rejected option, not a later refinement.
- The interrupt tag does not pass through `phaseAfterFailure`. A change that routes it there re-opens the premature-ready path #8007 closed.
- No backend name appears under `apps/tuval/src/ai-agent/core/` as a result of this.
- No adapter is obliged to emit the tag. A test or a fold that requires it from every layer re-introduces the Claude-only requirement the fence forbids.

## Consequences

The operator learns the difference between "refused" and "not confirmed", and learns it across a restart, because the tag is data the checkpoint carries.

The cost is a second rule in the fold: `phaseAfterFailure` is no longer the whole story for a `failure` event, so a reader of `fold.ts` has to know one tag is routed around it. That is the price of not moving the phase, and it was the reason option (b) needed a ruling rather than a build.

[#7991](https://github.com/kamp-us/phoenix/issues/7991)'s criteria allow a new out-port projecting the session's current failure. Once both land, that port is a plausible carrier for this readout. That is sequencing between two tickets, not a dependency this record creates.

## Records

no vocabulary impact
