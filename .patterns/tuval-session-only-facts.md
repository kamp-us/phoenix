# Keeping a fact the backend's own log does not carry

A Tuval AI-agent window renders rows from two sources: this process's live tail, bounded by
`planTranscriptWindow`, and the backend's stored history, read a page at a time. A fact stamped on a
row in the tail therefore lives exactly as long as the tail holds that row — and when a backend's log
does not record the same fact, the store's copy of that row is not merely older, it is **wrong**.

The instance this is drawn from is the operator's stop. Agy's `transcript.jsonl` records a cut reply
as a `MODEL`/`PLANNER_RESPONSE` with `status: "DONE"` and no field naming the stop — measured at agy
1.2.0 against the real CLI
([#8895](https://github.com/kamp-us/phoenix/issues/8895#issuecomment-5617179504)) — so a reply the
operator interrupted comes back from the store reading as the model's finished answer, and a
half-written response is drawn as a completed turn
([#8985](https://github.com/kamp-us/phoenix/issues/8985)). The tail's held copy carried the mark and
the store's did not; nothing reconciled them, and nothing red.

## The shape

**1. Record the fact beside the transcript, not only on the row.** The row is disposable; the record
is checkpointed. `cutReplies` is a field on `AiAgentSessionState`
(`apps/tuval/src/ai-agent/core/state.ts`) named in `checkpointFields`, holding the ids of every
assistant row this session cut.

**2. Bound it, and state the bound where it is declared.** A checkpointed collection that only grows
pays storage per session forever. `cutReplyLimit` drops the oldest, and the docblock says what it is
sized against — what a window can page back to, not how often the operator presses Escape.

**3. Fill it at the one place the fact is observed.** Every backend marks its own cut reply on the
item it emits, so `foldEvent`'s `item` arm (`apps/tuval/src/ai-agent/core/fold.ts`) catches all of
them and a fifth layer needs nothing added. `restore` (`state.ts`) adds the reply a checkpoint at
`prompting` cut, which no event will ever report.

**4. Re-apply it wherever the store's rows enter the process — every entrance.** This is the step
that is easy to half-do, and half-doing it is indistinguishable from doing it on the surface the
author happened to open. There are three today, and one function serves all three:

| Entrance | Call |
| --- | --- |
| A resume's refill over the store's whole history | `refillTranscript`'s `cut` operand (`apps/tuval/src/ai-agent/core/fold.ts`) |
| A checkpoint read back | `restore` (`apps/tuval/src/ai-agent/core/state.ts`) |
| The window's own `Load earlier messages` | `remarkCutReplies` before `mergeOlder` (`apps/tuval/src/shell/chat/ChatWindow.tsx`) |

`remarkCutReplies` is total and idempotent, so an entrance that is already correct is unchanged by
calling it, and an empty record is a no-op.

**4a. Join on the row's *whole* identity, because the record's ids are the live ones.** The fact is
observed on the row the layer streams, so the record holds live ids — and a backend that keys its
history in a second id space states the live id in the row's `alias`
(`apps/tuval/src/ai-agent/ports/transcript-item.ts`), never in its `id`. A re-mark reading `id` alone
therefore marks nothing at all on such a backend: agy's stored rows are `<cid>:line:<n>` against a
live `<cid>:<n>`, so every paged row missed and the cut turn came back reading "Worked for …"
([#9046](https://github.com/kamp-us/phoenix/issues/9046)). `remarkCutReplies` reads `id` **or**
`alias` — the same identity join the page/tail stitch performs (`unheld` in
`apps/tuval/src/shell/chat/rows.ts`). A fixture that gives the store's copy the live row's own id
collapses the two spaces and passes either way, which is how the first round shipped green and broken:
the case has to be keyed from a real page.

**5. Clear it with the conversation it describes.** The ids name rows in a store no page of the next
conversation reads, so the `session-reset` arm empties it beside the transcript.

## Where it stops

This is for a fact the backend **cannot** report, not one it merely has not reported yet. A fact the
next event will carry belongs on the event stream, and re-deriving it here would race the layer that
owns it — `foldEvent`'s `phase` arm is full of that argument. And the record holds ids alone: it is a
re-mark of rows the store returns, never a second copy of a row. A transcript the store does not have
at all stays where it already lives, in the held tail `rebaseOnStore` splices in whole.

Two invariants make the difference visible in review: a mark that lives only on a row is a mark
bounded by the window, and an entrance that reads the store without re-applying the record is a
surface that renders the backend's wrong answer.
