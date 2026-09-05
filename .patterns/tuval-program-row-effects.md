# Effects on a Tuval program row

How a Tuval program does work that needs a service, and how it holds a resource for as long as its
process lives. Everything here is `apps/tuval/src/`; the row type is
[`registry/program.ts`](../apps/tuval/src/registry/program.ts) and the runner is
[`process/Processes.ts`](../apps/tuval/src/process/Processes.ts).

## The split: plain core, Effect row

A program is one registry row (#7484 R1.1). Its `core` is a Demlik machine and stays plain data
— no Effect, no closure, no service reaches State, Cmd or Sub (#7371). Every Effect a program runs
lives on the row beside the core, in one of two records:

| Row field | Shape | Lifetime |
|---|---|---|
| `handlers` | `(cmd) => Effect<ReadonlyArray<Msg>, E, R>` | one shot, per Cmd |
| `subs` | `(sub, dispatch) => Effect<void, E, R \| Scope>` | long-lived, forked into a Scope of the Sub's own |

A Cmd handler answers with a list of follow-up Msgs. A Sub handler has many answers over time, so it
pushes them through `dispatch` and returns nothing; the host closes its Scope when the core stops
asking for that Sub.

Both records' `E` and `R` are inferred onto the row (`Program<S, M, C, U, Ctx, E, R>`), so a
program's failures and its service needs fall out of the code rather than being hand-declared. Never
widen `R` by hand to make a spawn typecheck — the spawn is what has to supply it.

**A Sub that needs a service belongs in `subs`, not on the machine.** Demlik 0.12's own `subscribe`
map is Promise-shaped and synchronous (`host/demlik-bridges.ts` is the whole translation), so a cell
there has nowhere to ask for a service. `Processes` prefers a row's `subs` entry over the bridged
cell of the same type, and a core carrying both keeps the bridge for the types the row leaves alone.

## `ProcessSelf`: the process's own Scope and state

[`process/self.ts`](../apps/tuval/src/process/self.ts) is the one service a running process's own
handlers may yield to learn about themselves. It carries two things:

- **`scope`** — the process's Effect Scope (#7513). Acquire here anything that must live exactly as
  long as the process: `Layer.buildWithScope(layer, self.scope)` puts the layer's finalizers on the
  process's stop rather than on the Cmd that happened to build it. Key the holder by `WeakMap` on
  the Scope object: two processes of one row are two keys, so they never share, and a stopped
  process's key is unreachable.

**A resource that can die under the process gets a child Scope, not a memo.** A memo keyed on the
process Scope is a per-process singleton, so a transport the backend dropped stays cached until the
process stops and every later call reaches the dead handle. Build into `Scope.fork(self.scope)`
instead: closing the child tears that connection down and detaches it from the parent, so rebuilding
is cheap and a process stop still closes the live one exactly once. When the core also names a Sub
over that resource, key the Sub's id on a generation the state bumps per rebuild — Demlik reconciles
Subs by id, so an id that does not change reads as "already running" and leaves the process
subscribed to the transport it just replaced.
- **`state()`** — the machine's committed state, as `unknown`. The registry erases a program's
  private types, so the program's own predicate reads it back (`isAiAgentSessionState` is the
  worked example). Use it to seed a projection, not to poll: a `dispatch` from a Sub handler is
  applied on the host's serial tail, so a read straight after one may not see it yet.

**Publish a projection by folding, not by reading back.** A Sub that dispatches a Msg and then wants
to emit what the core just committed should apply the core's own fold function to a local value
seeded from `ProcessSelf.state()` — same function, same seed, same order, so the two cannot diverge,
and there is no race to lose.

## Ports from a handler

A handler emits through [`ProcessPorts`](../apps/tuval/src/ports/ProcessPorts.ts), by port name. Two
failures come back and they are not the same thing:

- `PortNotWired` — nobody is listening. Swallow it. A program with no window still runs, and
  refusing to publish to nobody would turn every event into a handler failure.
- `PayloadRejected` — the route refused what this program emitted; the wire is a nominal kind plus a
  predicate, and the predicate said no. Let it fail the handler: that is a wiring bug in the graph,
  and it must be loud.

A program playing both ends of a two-way port kind names each end locally (`pageRequest` /
`pageReply`); `compile` matches on the kind, not the key.

## Inbound: `receive` is a pure translation with no failure channel

`receive[port]` turns an admitted payload into the program's private Msg. It is a plain function —
there is nothing to fail into. A payload the port's predicate admits but this end cannot act on (the
`page` half of a `transcript-page` arriving where a request belongs) becomes a Msg that records the
refusal as data, never a throw: a throw here happens inside the launcher's pump, where nobody is
waiting for it.

## Coming back from a checkpoint: a resume Msg, and a Cmd that republishes

Durability is the kernel's ([`durability/Checkpoints.ts`](../apps/tuval/src/durability/Checkpoints.ts)),
so a row does not write its own snapshot. What a row owes is the other half: what its state means
after a restart, and what has to happen before it is usable again. Three rules, all of them visible
in [`ai-agent/restore/`](../apps/tuval/src/ai-agent/restore/).

**The rehydrating `init` transforms and emits nothing.** Demlik throws on a non-null `loaded` whose
`init` returns any Cmd (`@demlik/tea` 0.12 `runtime-types.ts`) — that branch is the migration and
parse boundary, not a boot hook. So the transform states what a saved state *is* now: a process that
holds no transport any more comes back `idle` (every phase but the terminal `gone`), a run-scoped
field — a stale refusal, a page fetched from a transport that is gone — comes back empty, and a turn
that was mid-reply when the process died comes back marked interrupted rather than pretending the
work is still running.

**Whatever the restore has to *do* is a Msg someone dispatches after the spawn** — that is the route
the guard's own error message names. Keep it as a pure function of the restored state — Tuval's is
`resumeMessages(state)` — so a spawner asks the row what to send instead of encoding the row's
lifecycle at the call site, and a state with nothing to resume answers with an empty list.

**A restored process publishes nothing until something republishes it.** Out-ports are event-driven:
a projection leaves when the fold moves it. A process brought back from a checkpoint has a full
state and no events coming, so a window attached to it renders nothing — and a pending request the
backend is still waiting on wedges, because the event that would clear it only arrives after it is
answered. The fix is a Cmd whose handler reads the committed state and emits the projections again,
scheduled by the same Msg that resumes. It is the one handler that reads `ProcessSelf.state()`
rather than folding forward, and the reason is that there is no event to fold.
