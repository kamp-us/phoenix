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

**A Sub handler's failure ends the process, so treat returning as the only clean exit.** ADR
[0346](../.decisions/0346-sub-failure-policy-actor-identity.md) makes a failed Sub the machine's Msg
or the process's death, never a host retry: the host reports the `Cause` under `"sub-fiber"`, marks
that Sub's id `failed`, and — with no `subFailure` projection to address it — closes the process's
Scope with the failure as its Exit. Marked ids are never re-armed, `ended` ones included, so a Sub
that returns normally does not restart while the state keeps desiring it. Restart is data: emit the
Sub under a new id (an attempt counter in the id, or in the dep-keyed `deps` slice) and reconcile
arms it fresh, which is what makes the retry replay. Catch inside the handler anything you mean to
survive; let out only what should end the process. Declaring `subFailure` on a program row's `core`
is not reachable yet — [#7933](https://github.com/kamp-us/phoenix/issues/7933) carries it.

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
