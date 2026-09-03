# @kampus/tuval

Tuval is a local app you run on your own machine: "Neovim plus tmux for processes, in a browser".
It hosts programs — a Pi session, a Claude session, a shell — as processes that talk to each other
only through typed ports, survive a restart, and show up in windows.

## Why it exists

The Tuval proof of concept (PR #7190, branch `epic/7140`) proved the product but could not host a
second program or restart on its own terms. This is its replacement, built beside it from scratch
(ADR 0345, epic #7496): a kernel first, then each program as its own slice. The POC branch stays
frozen as the behavioural oracle; nothing here imports from it.

Tuval lives under `apps/` because a person runs it, not because Cloudflare hosts it. It has no
`alchemy.run.ts`, no worker entry and no stack, and it never deploys.

## Running it

```bash
pnpm install          # from the repo root, once
cd apps/tuval
pnpm dev              # boots under Node and reports the registered program count
pnpm test             # the unit tier (vitest)
pnpm typecheck
```

`pnpm dev` runs `node src/bin.ts`. Node strips the TypeScript itself, so there is no build step.

## Your config

Configuration is code you own, the Neovim model. Boot imports `tuval.config.ts` at the app root
and registers every program row in the list it default-exports. A row is a `Program`
(`src/registry/program.ts`): one stable id, a private Demlik core machine, public typed ports, host
handlers, a capability request list, an optional renderer reference, and the identity / capability /
placement records as inert data — the kernel enforces nothing on them, local code is fully trusted.
The list is empty today; the in-the-box programs land with their own slices.

Loading is fail-closed. A config module that throws, has no default export, or default-exports
something that is not a list refuses boot with a message naming the module and the reason:

```
tuval: refusing to boot — config module /path/to/tuval.config.ts: module threw while loading: boom
```

`node src/bin.ts <path>` boots from another module, which is how the tests exercise the refusals.

## The host

`src/host/` runs a Demlik core machine as an Effect actor: `make(definition)` is a scoped Effect
yielding an `ActorHandle`, and `layer(key, definition)` provides that handle as a service. A
definition is `defineActor({machine, interpret, subscribe, store?})` — the machine is Demlik's pure
core (`init`, `update`, dep-keyed `subs`, `identity`, `subscriptions`), the handlers are
Effect-valued, and their error and service requirements fall out onto the handle.

It stands in for Demlik's own `tea-effect` until kamp-us/demlik#36 ships. The places it still
speaks Demlik 0.12's Promise and disposer shapes live in `src/host/demlik-bridges.ts`, which is the
swap point; `parity.unit.test.ts` runs one machine through both hosts and asserts they agree.

## Processes

`src/process/` runs a program as a process: one running instance with a stable id, its own Effect
Scope forked from its parent's, and a row in the `ProcessTable`. `Processes.spawn(programId,
{parent?})` resolves the row from the `Registry`, builds the actor through the host, and hands back
a `ProcessHandle`; `Processes.stop(id)` (or `handle.stop`) closes the process Scope, which is the
whole shutdown protocol — descendants first, then the actor's drain, Demlik Sub disposers and Effect
finalizers, then the row leaves the table. A dispatch after stop is refused with
`ActorStoppedError`; it never reaches the machine. Two processes of one program share nothing.

`Processes.layer` provides `Processes` and `ProcessTable` together over one live map and needs the
`Registry`. The table is in-memory and read-only from outside; publishing it as a port is a later
slice.

## Ports

Ports are the only process-to-process protocol. A program's private Demlik `Msg` never crosses a
process boundary; what another process may see of a program is its `ports` on the registry row.
A port is a nominal runtime kind plus a payload predicate (`{kind: "tick/v1", direction, accepts}`),
the shape spike #7379 routed on — not a schema system. An in-port also declares its `bound`
(`{capacity, overflow}`), because only an in-port owns a queue: `overflow` is Effect's own queue
strategy (`suspend`, `dropping`, `sliding`), so no port queue is ever unbounded.

`src/ports/` compiles a graph and opens its queues. A graph is authored as nodes that own their
outbound routes as `on` entries; there is no top-level edge list.

```ts
const graph: Graph = {
	nodes: [
		{id: NodeId.make("p"), program: ProgramId.make("producer"), on: [{port: "ticks", to: {node: NodeId.make("c"), port: "ticks"}}]},
		{id: NodeId.make("c"), program: ProgramId.make("consumer"), on: []},
	],
};
const wiring = yield* open(yield* compile(graph)); // needs Registry; scoped
yield* wiring.emit({node: "p", port: "ticks"}, 1);
const inbox = yield* wiring.inbox({node: "c", port: "ticks"});
```

`compile` runs over registry rows before any process exists and refuses the graph there: a route
whose source kind does not match its target kind (`IncompatibleRoute`, naming both kinds and both
program ids), a route naming a port a program does not declare in that direction
(`UndeclaredPort`), a route to a node the graph does not declare, a duplicate node id, or an
in-port whose capacity is not a positive integer. `open` builds one queue per in-port at its
declared bound and delivers each `emit` to every routed target in authoring order, so a compatible
route delivers in order. The slice never imports `src/process/`.
