# What a `TuvalAiAgent` layer owes the core, per turn

Every agent layer under
[`apps/tuval/src/ai-agent/service/TuvalAiAgent.ts`](../apps/tuval/src/ai-agent/service/TuvalAiAgent.ts)
pushes one `AgentEvent` stream, and the core folds it. Three of those events are a promise the layer
makes about every turn — two `phase` events and one `result` — and nothing in the type system holds
the layer to any of them: no signature says a turn ended, so a layer that never says one did
compiles clean and passes every generic test. Two layers shipped that omission before this was
written down ([#7963](https://github.com/kamp-us/phoenix/issues/7963),
[#7897](https://github.com/kamp-us/phoenix/issues/7897)).

## What the layer owes

Per turn, exactly three events — the two `phase` events and the `result` between them:

| Moment | Event | Who |
|---|---|---|
| The turn starts — the write that hands the backend the operator's text | `prompting` | the layer |
| The turn ends, however it ended — one payload, just ahead of the phase below | `result` | the layer |
| The turn ends, however it ended | `ready` | the layer |
| A session opening or coming back | `starting`, `reconnecting` | the core, never a layer |
| Before any start | `idle` | the core's `initialState` |
| The transport is away for good | `gone` | the layer |

`starting` and `reconnecting` are not the layer's to send because the core is already inside the
open the layer would be describing: it is `ready` off the `started` that the layer's own `start`
call answered, so folding a late `starting` would walk a live session backwards into a phase where
`promptRefused` is the only answer a prompt gets. `coreOwned` in
[`core/fold.ts`](../apps/tuval/src/ai-agent/core/fold.ts) drops both, which makes a layer that
sends one a layer writing to a channel nobody reads
([#7925](https://github.com/kamp-us/phoenix/issues/7925)).

## The two enforcement sites, and why the omission is fatal

- [`core/fold.ts`](../apps/tuval/src/ai-agent/core/fold.ts) — `foldEvent`'s `phase` arm is the only
  thing that moves a session's phase. It is also where a turn's other loose ends settle: any phase
  but `prompting` runs `settleTurn`, `interruptionAfter` drops an outstanding interrupt request,
  and `settleAccepted` reaches the running send so its window may drop the copy it was holding
  ([#8005](https://github.com/kamp-us/phoenix/issues/8005),
  [#8007](https://github.com/kamp-us/phoenix/issues/8007)). The turn-end `ready` is not decoration
  on a phase line — it is the event four pieces of state wait on.
- [`core/machine.ts`](../apps/tuval/src/ai-agent/core/machine.ts) — the `prompt` cell, which has an
  arm per case and records every answer as data rather than throwing it. At `ready` the send is
  admitted. At `prompting` it is **queued** (`enqueue`, bounded by `queueLimit` in
  [`core/queue.ts`](../apps/tuval/src/ai-agent/core/queue.ts)) and answered `promptQueueFull` only
  once the queue is full — a prompt written while the turn runs waits rather than being refused
  ([#8159](https://github.com/kamp-us/phoenix/issues/8159)). Every other phase — `idle`,
  `starting`, `reconnecting`, `gone` — is `promptRefused`. What drains the queue is `settleQueue`,
  and it admits the head only when the session lands back on `ready` (at `gone` or `idle` it
  releases what is queued with `promptUnqueued` instead).

So a session wedged at `prompting` by a missing turn-end `ready` does not refuse anything at first:
it swallows each later prompt into a queue nothing will ever drain, and then answers
`promptQueueFull` once that queue fills. Fatal either way, but `promptRefused` is not the failure to
grep for, and it is not what a conformance test over this contract should assert.

The pair is load-bearing, not just the end of it. A layer's `prompt` returns at the *send*, and the
`prompt` cell has already walked the session to `prompting` on its own before `aiAgent.prompt` is
called — so a bare `ready` with no `prompting` ahead of it lands in that gap looking exactly like a
turn's end and accepts a send the backend never started
([#8107](https://github.com/kamp-us/phoenix/issues/8107)). `prompting` marks the send's turn
running; only that turn's end accepts it.

## The open's own `ready`, and the first turn it can swallow

A layer narrates its open on the same stream it narrates turns on, and the core is not listening
yet. `subscriptions` in [`core/machine.ts`](../apps/tuval/src/ai-agent/core/machine.ts) opens the
events Sub off `state.sessionId`, which the `started` Msg sets — and `started` is what the layer's
own `start` call answered, so everything `start` emitted is already sitting in the layer's queue
when the Sub attaches. The queue is unbounded and nothing is lost; what varies is *when* it drains.

That leaves a window: the core reaches `ready` on `started`, so a prompt written in it is admitted
and `admit` walks the session to `prompting` — and then the open's own `ready`, folded a moment
later, walks it straight back. The turn is running and the phase line says `Ready.`, with no
`Working…` and no Escape affordance, which is what an operator measured across a 30 s first turn on
a picker-opened Claude session ([#8358](https://github.com/kamp-us/phoenix/issues/8358)). A page
re-attaching to an already-open process never sees it: that process opened long ago and has no
opening events left to drain.

The per-turn `prompting` is the whole defence, and it is why the layer owes one at the send rather
than leaving `admit`'s to stand. It rides the same queue *behind* the open's events, so the session
is back on `prompting` before the turn's first frame whichever order the drain took
([#8156](https://github.com/kamp-us/phoenix/issues/8156)). Both orders are pinned in
[`claude/agent/phases.unit.test.ts`](../apps/tuval/src/claude/agent/phases.unit.test.ts), which
folds the layer's real event stream through the real core — including the case with that one event
removed, where the running turn reads idle for its whole length.

So a layer whose `start` narrates a `ready` owes a `prompting` per send. Emitting one only when the
backend confirms the turn — or trusting the core's own admission — leaves the first turn of every
freshly opened session narrated as idle.

## The open's `ready` ships with its catalogs

The open's `ready` is also the answer to a second question, and the layer owes both in one batch:
**emit `model` and `thinking` before the `ready` that closes the open, never after it.**

A layer's `models`/`thinking` slices start on the reducer's empty defaults
([`core/state.ts`](../apps/tuval/src/ai-agent/core/state.ts)), and an empty offered set is two
different facts — "the layer has not answered yet" and "answered, nothing offered". Nothing in
`AgentEvent` distinguishes them, so
[`shell/chat/composer-bridge.ts`](../apps/tuval/src/shell/chat/composer-bridge.ts) reads the answer
off the phase instead: past `starting`, the offer counts as resolved, and the composer stops showing
`loading` and starts showing `thinking effort: none offered`. That read is only true of a layer
whose catalogs are already folded when its `ready` lands.

`ClaudeAiAgent` used to emit `ready` first and its catalogs 52 lines and four awaited subprocess
round-trips later — `supportedModels`, `getContextUsage`, `supportedCommands`, `applyFlagSettings` —
so every Claude session opened onto a disabled picker reading `none offered` until they returned
([#8425](https://github.com/kamp-us/phoenix/issues/8425)). Delaying `ready` behind them costs
nothing the core can see: the core reaches `ready` on the `started` Msg that `start` *returns*, and
nothing drains the layer's queue before then, so no prompt can be admitted inside the window either
way.

`PiAiAgent` sends the whole handshake as one `emit` array with `phase: ready` last; `ClaudeAiAgent`
now batches `thinking` with it. A new layer copies that order.

## A catalog that dies with its session is announced as dead

A catalog read off a live session belongs to that session, so a teardown empties it. **The emptying
is an event, not only a write to a `Ref`**: a consumer that is not told keeps painting the dead
session's rows, and every pick it then takes is judged against a catalog nothing holds
([#8542](https://github.com/kamp-us/phoenix/issues/8542)).

Where the layer says it matters, because a teardown shuts the queue it happened on.
`ClaudeAiAgent.closeCurrent` empties `models` and `efforts` and says nothing; `start` says it on the
*new* queue, right behind that queue's `starting` and only when a session was actually torn down.
That places the clear ahead of the `gone` a refused reconnect emits, which is the one path with no
later catalog to correct it.

The selection does not go with the catalog. A pick is the operator's, not the session's, so the
clear carries `current: <the held pick>` beside `available: []`, and the picker names the pick while
saying the offer behind it is empty ([`AgentChatInput`](../packages/design/src/AgentChatInput.tsx)'s
`SettingMenu` takes it as `held`). The next open re-validates it against the catalog it reads and
drops it there if that catalog does not carry it — the deferred validation of
[#7981](https://github.com/kamp-us/phoenix/issues/7981), which is also why a setter with no session
holds a pick rather than refusing it against an empty offer.

## The turn's own answer, beside the phase that ends it

A phase says a turn *ended*; it does not say what the turn **answered**. A consumer outside the
window — a parent program routing an answer onward, a config route reading an agent's output — has
no transcript to read it off, so the layer owes one `result` event per finished turn as well
([#8724](https://github.com/kamp-us/phoenix/issues/8724), ruling R19.3 on
[#8715](https://github.com/kamp-us/phoenix/issues/8715)). The program folds it and publishes it on
its `result` out-port, and the kernel's `process read` answers with the last one.

Three things make it the same class of promise as the turn-end phase, so they are written down
together:

- **Once per finished turn, however the turn ended.** A failed turn, an interrupted one and a turn a
  local command ended all owe one — marked, not skipped. A consumer told nothing about a failed turn
  waits for an answer that is never coming, which is the same wedge a missing `ready` is. A failure
  is a turn's end whether or not a phase follows it, because that is what the core does with one:
  `phaseAfterFailure` in [`core/fold.ts`](../apps/tuval/src/ai-agent/core/fold.ts) walks a
  `prompting` session to `ready` off any failure, emitting nothing on the layer's stream, and
  `foldInterruptRefusal` beside it does the same for every interrupt refusal but `turn-running` —
  the one case where the reply is still being written. So the fold closes the turn on the failure
  itself, and a layer that does emit its own closing phase behind one adds no second result.
- **Ahead of the event that closes the turn**, never behind it. `session-reset` is a turn's end and
  a conversation swap in one event, and the core's events Sub is keyed on the session id
  (`core/messages.ts`) — so a result pushed after the swap is dropped by the machine's own identity
  filter, under an id that no longer names this conversation.
- **Only inside a turn.** A layer narrates its open on this same stream and the open's `ready` looks
  exactly like a turn's end (see the section above); an answer published there is one no operator
  asked for.

**A layer does not hand-roll the bookkeeping.** `withTurnResult` in
[`apps/tuval/src/ai-agent/turn-result.ts`](../apps/tuval/src/ai-agent/turn-result.ts) derives the
event from the bracket this contract already requires — it watches `prompting` … turn-end, collects
the turn's items as they arrive (upserted by id, so a re-sent row is carried once as it last stood),
takes the newest assistant row's text, and answers `ok: false` for a turn that carried a refusal,
ended at `gone`, or drew a reply the backend flagged cut short. The layer's whole share is the wrap
on its own `events` member:

```ts
events: withTurnResult(Stream.unwrap(Effect.map(Ref.get(queue), (held) => Stream.fromQueue(held)))),
```

Two things about that wrap are load-bearing. It goes on the `events` member itself, so **one
subscription carries a whole turn** — the tracker's state is per subscription, and a turn read across
two of them has no bracket to close (which is exactly what the host does: one `runForEach` over
`events` per connection). And a layer with a better answer than the fold can derive may push its own
`result` inside the turn; the fold then adds none, so the two can never both land.

Each layer's own test proves it rather than a shared conformance suite, because a layer that drops
the wrap compiles clean:
[`claude/agent/phases.unit.test.ts`](../apps/tuval/src/claude/agent/phases.unit.test.ts),
[`codex/agent.unit.test.ts`](../apps/tuval/src/codex/agent.unit.test.ts),
[`pi/ai-agent/turn-end.unit.test.ts`](../apps/tuval/src/pi/ai-agent/turn-end.unit.test.ts),
[`agy/ai-agent/pays-the-turn-result.unit.test.ts`](../apps/tuval/src/agy/ai-agent/pays-the-turn-result.unit.test.ts)
and [`ai-agent/service/ScriptedAiAgent.unit.test.ts`](../apps/tuval/src/ai-agent/service/ScriptedAiAgent.unit.test.ts).
The fold's own cases are [`ai-agent/turn-result.unit.test.ts`](../apps/tuval/src/ai-agent/turn-result.unit.test.ts).

## Reference shapes

- [`claude/agent/ClaudeAiAgent.ts`](../apps/tuval/src/claude/agent/ClaudeAiAgent.ts) — `prompt`
  publishes `prompting` *before* the write to the CLI's input (a write that then fails is a turn
  nobody ran, and its `PromptError` settles the send on its own arm), and `drive` publishes `ready`
  on the SDK's `result` message, which is the one frame that means a turn is over. The per-turn
  `init` frame is not that frame: it leads a turn rather than closing one, and taking it for the
  turn-end phase was #7963. Copy its turn handling, not its `start`: that emits a layer `starting`
  the core drops on the floor, and its own comment beside the line says so.
- [`pi/ai-agent/items.ts`](../apps/tuval/src/pi/ai-agent/items.ts) — `phaseOf` derives the pair from
  the backend's own session phase (`idle` → `ready`, anything else → `prompting`) and the fold
  emits it only on a change. A snapshot-pushing backend gets the contract for free this way; what
  it does not get for free is delivery, and a queue between the layer and the core that coalesces
  snapshots can drop the one carrying the change (#7897). See
  [snapshot-authoritative-to-delta-events.md](./snapshot-authoritative-to-delta-events.md).
- [`claude/proof/script.ts`](../apps/tuval/src/claude/proof/script.ts) — the fixture scripts are
  where a scripted session's narration lives, one `prompting` … `ready` bracket per turn, with the
  restart-cut turn deliberately missing its `ready` so a proof can assert what an unfinished turn
  looks like. `service/ScriptedAiAgent.ts` itself narrates no per-turn phase — it replays whatever
  the script carries — so a new script owes the brackets its layer will not add.

## Writing a new layer

Find the backend's own "turn is over" signal and bind `ready` to that one signal, not to something
adjacent to it. If the backend has no such signal, the turn's end is whatever the layer decides it
is, and that decision belongs in the layer with a comment naming it — not left to a phase that
happens to arrive. Then check the path between the emit and the core: any queue, dedupe or
coalescing step in between can swallow the event, and the core cannot tell a swallowed `ready` from
a layer that never sent one.

A conformance test over every layer would be stronger than this doc. The layers differ enough in how
a turn is driven that its shape is an open question; no such test exists today and none is filed.
What does exist is the shared fold above — `withTurnResult` is the same bookkeeping in one place, so
the turn-result half of this contract has one implementation to get right rather than five.

## An open outcome also ends a subscription lifetime

The transport is rebuilt before the agent's `start` call in
[`handlers/index.ts`](../apps/tuval/src/ai-agent/handlers/index.ts), so both `started` and
`openFailed` advance `connection`. The latter is a dedicated completion message, not a diagnostic
classification: an ordinary `failed` message has rebuilt nothing and cannot advance the generation.
The existing failure fold still chooses `idle` for a refused open and `gone` for a missing resumed
session; a process with no session id or a terminal session desires no event subscription.

This distinction follows the current host's
[`reconcile`](../apps/tuval/src/host/actor.ts): an ended or failed manual subscription keeps its
registered id, and an unchanged id is never re-armed. A new generation closes that registration and
subscribes to the agent now held by the slot. The slot's child Scope independently closes the old
transport on rebuild; Effect rc.112's `Scope.fork` documents that closing a child detaches it from
its parent. Neither an ended event fiber nor a failed start can stand in for the new lifetime id.

The handler regression drives the real process registry with a script whose second build refuses
start. It observes the changed desired id, a notification from that rebuilt agent's actual event
queue, and a reply after a third build reconnects successfully. Transport and subscription
finalizers are counted separately, and ordinary failure keeps the existing subscription identity.
