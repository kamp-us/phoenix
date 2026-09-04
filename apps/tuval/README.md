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
pnpm dev              # boots the two demo programs; Ctrl-C stops and checkpoints them
pnpm test             # the unit tier (vitest)
pnpm typecheck
```

`pnpm dev` runs `node src/bin.ts`, an Effect CLI (`effect/unstable/cli`) over the pure `boot`.
Node strips the TypeScript itself, so there is no build step. Boot loads your config layers (see
"Your config"), registers their programs, launches the processes the graph plans, restores any
other checkpointed process from the project's `.tuval/`, prints the process table, and stays up
until Ctrl-C (SIGINT or SIGTERM), which stops and checkpoints every process and exits 0; a config
that plans no process exits right after the report.

```
tuval [flags]
  --config file          Global config module (default: ~/.tuval/tuval.config.ts)
  --project directory    Project dir whose .tuval/ holds the project config and state (default: cwd)
  --help, --version
```

`node src/bin.ts --config <module>` swaps the global layer, which is how the tests exercise the
refusals; `--project <dir>` runs against another project's `.tuval/`. A path named by either flag
must exist.

```
tuval: booted — 2 program(s) registered from …/apps/tuval/.tuval/tuval.config.ts; 2 process(es) live, 0 restored from …/apps/tuval/.tuval
tuval: process counter program=counter parent=- ports=ticks:out(count/v1) state=running@0
tuval: process log program=log parent=counter ports=ticks:in(count/v1) state=running@0
tuval: running — Ctrl-C stops and checkpoints
count 1
count 2
```

The two programs in the box are the demo counter and log (`src/demo/`, #7517): the counter ticks
once a second and announces each count on its `ticks` out-port, the log records what arrives on
its `ticks` in-port and prints it. They are boring on purpose — they exist to prove the kernel
routes, checkpoints and restores, not to anticipate the real programs — and they are ordinary
rows registered by the config like any other. Stop and run again: both come back at their saved
state, the counter picks up where it left off, and `restored` counts them.

## Your config

Configuration is code you own, the Neovim model, in two layers: a global module at
`~/.tuval/tuval.config.ts` and an optional project module at `.tuval/tuval.config.ts` in the
project dir (the cwd, or `--project`). Either may be absent — an absent layer is empty, and a
boot with neither registers nothing. The two merge project-over-global: a program row or a graph
node in the project layer replaces the global one with the same id, in place; the rest append.
This repo's `apps/tuval/.tuval/tuval.config.ts` is the project layer `pnpm dev` runs against, and
the checkpoints land beside it (that dir is gitignored except for the config).

A config module default-exports one versioned object, `TuvalConfigInput` from `src/config.ts`:
`version: 1`, `programs`, and an optional `graph`. A row is a `Program` (`src/registry/program.ts`):
one stable id, a private Demlik core machine, public typed ports, a `receive` map that turns what
arrives on each in-port into the program's own Msg, host handlers, a capability request list, an
optional renderer reference, and the identity / capability / placement records as inert data — the
kernel enforces nothing on them, local code is fully trusted. The graph names the processes to run
and the routes between them (see "Ports" and "Launch" below); a config without one registers its
programs and runs nothing.

```ts
import {Console} from "effect";
import type {TuvalConfigInput} from "../src/config.ts";
import {demoGraph, demoPrograms} from "../src/demo/index.ts";

export default {
	version: 1,
	programs: demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
	graph: demoGraph,
} satisfies TuvalConfigInput;
```

Loading is fail-closed. The shape is one Effect `Schema` (`TuvalConfig`), so a module that throws,
has no default export, or exports something the schema rejects — a version other than 1, a row
without an id, a `graph` that is not a graph — refuses boot with a message naming the module, the
place and the reason:

```
tuval: refusing to boot — config module /path/to/tuval.config.ts: module threw while loading: boom
tuval: refusing to boot — config module /path/to/tuval.config.ts: not a v1 config at graph: Expected object
```

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
`Registry` and `Checkpoints`. The table is in-memory and read-only from outside. Its `changes` stream reports every
spawn, stop and committed transition; a row's `stateSummary().revision` counts those transitions,
so a reader can tell the summary moved without reading the state.

A spawn takes `services`, a `Context` provided to that process's handlers and to nothing else: a
program whose handlers require a service says so in its row's `R`, and whoever spawns it supplies
one per process. The launcher uses this to hand each process its own `ProcessPorts`.


## Durability

Durability is the kernel's, not a program's (`src/durability/`). Every spawn opens the process's
checkpoint through `Checkpoints.open`, an Effect acquire/release under the process Scope, and hands
the host the `Store` it gets back; the host's own save-before-effects ordering does the rest, so
the only persistence path is Demlik's stores — `fileStores(dir)` (Demlik's `fileStore`, the local
app's, at `<dir>/manifest.json` + `<dir>/processes/<id>.json`) or `memoryStores()` (Demlik's
`memoryStore`, the tests'). A snapshot is the machine state under the program id and version that
wrote it; the manifest lists every checkpointed process in spawn order, parents first.

On boot, `restore` spawns every manifest entry back at its saved id and parent link, at its
checkpointed state; a clean stop and reload replays nothing, and one new input after it produces
exactly one new effect. An entry the launcher already brought back — a planned process spawns at
its node's id, and opening that checkpoint is its restore — is left alone. A snapshot written under another program version (or another program) is
refused with `SnapshotRefused`, naming the process and both versions, and the boot stops there —
nothing is ever fresh-booted over a refused snapshot:

```
tuval: refusing to boot — snapshot for process "p-1" refused: written by counter@0.9.0, the program is now counter@1.0.0
```

Not here: crash-window exactly-once, schema evolution between versions, remote nodes.

## The process-table port

`src/table/` publishes the table as an ordinary out-port, so a projection is an ordinary consumer.
`processTablePort` is the declaration (`{kind: "tuval/process-table/v1", direction: "out",
accepts}`), typed like any port a program declares; a projection declares an in-port of that kind
and routes to it through a graph like any other route. `ProcessTablePort.layer` (needs
`ProcessTable`) reads `rows`, streams `changes`, and `feed(wiring, from)` emits every change on the
out-port `from` until interrupted.

The row is program-blind: `id`, `programId`, `parentId`, `ports` as `{kind, direction}` per name,
and `stateSummary` as `{lifecycle, revision}`. No machine state and no program-specific payload
ride it, so a consumer tells a Pi process from a Claude one by `programId` and by nothing else, and
a `ps`-style list or an engine view renders every row from the port alone. Nothing on the port
mutates the table: spawning, stopping and rewiring are not reachable through it.


## Ports

Ports are the only process-to-process protocol. A program's private Demlik `Msg` never crosses a
process boundary; what another process may see of a program is its `ports` on the registry row.
A port is a nominal runtime kind plus a payload predicate (`{kind: "tick/v1", direction, accepts}`),
the shape spike #7379 routed on — not a schema system. An in-port also declares its `bound`
(`{capacity, overflow}`), because only an in-port owns a queue: `overflow` is Effect's own queue
strategy (`suspend`, `dropping`, `sliding`), so no port queue is ever unbounded.

`src/ports/` compiles a graph and opens its queues. A graph is authored as nodes that own their
outbound routes as `on` entries; there is no top-level edge list. A node is a planned process,
so it may name a `parent` — a node declared before it, which is what makes authoring order the
spawn order.

```ts
const graph: Graph = {
	nodes: [
		{id: NodeId.make("p"), program: ProgramId.make("producer"), on: [{port: "ticks", to: {node: NodeId.make("c"), port: "ticks"}}]},
		{id: NodeId.make("c"), program: ProgramId.make("consumer"), parent: NodeId.make("p"), on: []},
	],
};
const wiring = yield* open(yield* compile(graph)); // needs Registry; scoped
yield* wiring.emit({node: "p", port: "ticks"}, 1);
const inbox = yield* wiring.inbox({node: "c", port: "ticks"});
```

`compile` runs over registry rows before any process exists and refuses the graph there: a route
whose source kind does not match its target kind (`IncompatibleRoute`, naming both kinds and both
program ids), a route naming a port a program does not declare in that direction
(`UndeclaredPort`), a route to a node the graph does not declare, a parent the graph does not
declare before the child (`UnknownParent`), a duplicate node id, or an in-port whose capacity is
not a positive integer. `open` builds one queue per in-port at its declared bound and delivers
each `emit` to every routed target in authoring order, so a compatible route delivers in order.
The slice never imports `src/process/`.

`ProcessPorts` is the wiring as one running process sees it: `emit(port, payload)` on its own
out-ports by name. A program's Cmd handler requires it as a service and never learns which node
it runs as; the launcher provides one per process.

## Launch

`src/launch/` runs a compiled graph: one process per node, spawned at the node's own id under the
node's parent, with the wiring bound both ways — the process's handlers get its `ProcessPorts`,
and every in-port gets a pump that takes from the port's queue, turns the payload into a Msg
through the row's `receive` entry for that port, and dispatches it, in queue order, for as long
as the process lives. A node whose id is already checkpointed comes back at its saved state,
because the spawn opens that checkpoint like any other spawn does. A node whose program declares
an in-port with no `receive` entry is refused (`NoReceiver`) before the first spawn.

`start` in `src/boot.ts` is the whole app from rows and a graph: compile over the registry (a bad
route refuses here, with nothing spawned and nothing written), open the wiring, build the kernel,
launch, then `restore` whatever else the manifest names. `boot` is `start` from the layered
config. `src/demo/e2e.unit.test.ts` is the proof that this holds across a stop and a second boot.

## Shell: the layout tree

`src/shell/layout/` is the pure window layout — the tmux half of the shell, ported by hand from
Studio's `monorepo/packages/layout-tree/src/index.ts` after the invariant audit #7551 asked for.
Nodes are windows and stacks with stable ids, addressed by id and never by position; a window holds
an optional process id and nothing else, so an empty window is an ordinary node. Nothing here
imports React, Demlik or Effect, so every operation is a plain function on immutable data.

```ts
let tree = createTree(createStack("root", "horizontal", [createWindow("w0")]));
tree = split(tree, "w0", "vertical", {window: "w1", stack: "s1"}); // w1 takes half of w0's share
tree = resize(tree, "root", {w0: 30, w1: 70});                     // percent, never pixels
findSibling(tree, "w0", "down")?.id;                               // "w1"
checkTree(tree);                                                   // [] — every invariant holds
```

`"horizontal"` means the children sit side by side; Studio inverts that at its render boundary and
this port does not (see `.glossary/LANGUAGE.md` §"Tuval: stack, orientation, size, zoom"). A split
of a single-child stack flips that stack instead of nesting a new one; `remove` collapses an emptied
stack into its grandparent, replaces a stack left holding one child with that child, and hands the
freed share to the sibling the window sat against, which makes it the exact inverse of the split
that created the window. Removing the tree's last window is refused — what closing the last window
means is the shell's call, not the tree's. `checkTree` states the invariants as data, so the
persistence boundary can reject a restored tree instead of rendering a broken one.

## Shell: the core machine

`src/shell/core/` is the shell's private Demlik core — one `defineMachine`, and the one place the
desk is written. State is workspaces keyed by id beside an `activeWorkspace` (Studio's shape, from
`monorepo/packages/studio/studio.ts`), each workspace a layout tree and the window focus sits in,
plus a view slot per window and the prefix. All of it is JSON, because the kernel checkpoints it
like any other process's state; the type-level proof is in `boundary.unit.test.ts`.

```ts
const [state, cmds] = applyMsg(defaultPrefixTable, initialState(), {
	type: "keys.press",
	key: {key: "b", ctrlKey: true},   // the prefix arms: cmds is [{type: "startPrefixTimer", …}]
});
applyMsg(defaultPrefixTable, state, {type: "keys.press", key: {key: "|"}}); // splits, side by side
```

Two shapes are worth knowing. **A bound key runs its command's Msg in the same transition** — one
press is one commit and one checkpoint — and a name the core does not own (`command:open`,
`config:reload`, one of yours) leaves as a `runCommand` Cmd for the command rows instead. **The
prefix timer is the host's, and there is exactly one**: the core says when a window opens
(`startPrefixTimer`, carrying its length in ms) and when it closes (`cancelPrefixTimer`), and the
host feeds `prefix.timeout` back when it fires.

Two refusals and one absence carry the model. The last window of a workspace does not close and the
last workspace is not removed, for the same reason: a desk with nothing on it has no layout to
render and no focus to hold. And there is no Cmd arm that stops a process, so closing the last
window showing one cannot end it — a window is a view onto a process, not a container for it.

## Shell: the page-to-kernel transport

`src/shell/transport/` is the one WebSocket a page attaches over — the tmux server/client split, with
the kernel and every process staying in Node and the page a view of them. The server accepts one
socket per page, streams the process-table port to it, and streams the public state of each process
that socket attaches to; the page side's `attach(url)` hands back exactly the `readProcess` and
`dispatch` the window contract needs, plus `readShell`.

```ts
const server = yield* serve({token: mintLaunchToken(), port: 0, handles});
console.log(server.launchUrl); // ws://127.0.0.1:<port>/?token=… — print this once

const page = yield* attach(server.launchUrl);
const shell = yield* page.attachProcess(shellProcessId);
yield* shell.dispatch({type: "split", window: "w1"});
```

Two rules shape it. **The shell is not special on the wire**: its state travels as an ordinary
process-state frame and the page finds it by reading the table for the shell program's row, so no
frame kind is the shell's. And **the page keeps no state of its own** — workspaces, layout, focus and
each window's view are fields of `ShellState` above, and every draft is its program's, which is why a
second tab on the same URL shows the same desk and a split done in one appears in the other.

Every frame is a nominal kind plus a predicate, like a port; one that does not decode closes the
socket with its reason. A process placed anywhere but the node host is refused by name
(`PlacementUnsupported`) rather than skipped. The kernel mints one random token per launch and the
printed URL is the only place it appears — it is a `Redacted` everywhere else, so a log line or a
snapshot cannot take it — and the upgrade is refused, before any frame, on a missing or wrong token
or on an `Origin` that is not the kernel's own loopback origin. That is not a sandbox and not user
auth: one user, one machine, other pages kept out. Re-attaching after a drop or a kernel restart
replays current state, never a transcript.

Its proof binds a real loopback socket, so it runs as this app's `integration` tier
(`pnpm test:integration`) beside the `unit` one.
