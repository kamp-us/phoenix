# The phase a `TuvalAiAgent` layer owes the core, per turn

Every agent layer under
[`apps/tuval/src/ai-agent/service/TuvalAiAgent.ts`](../apps/tuval/src/ai-agent/service/TuvalAiAgent.ts)
pushes one `AgentEvent` stream, and the core folds it. Two of those events are a promise the layer
makes about every turn, and nothing in the type system holds the layer to it: `AgentEvent` carries
no "turn over" shape, so a layer that never says a turn ended compiles clean and passes every
generic test. Two layers shipped that omission before this was written down
([#7963](https://github.com/kamp-us/phoenix/issues/7963),
[#7897](https://github.com/kamp-us/phoenix/issues/7897)).

## What the layer owes

Per turn, exactly two `phase` events:

| Moment | Phase | Who |
|---|---|---|
| The turn starts — the write that hands the backend the operator's text | `prompting` | the layer |
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
