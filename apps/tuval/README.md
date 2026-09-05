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
pnpm dev              # boots the shell + the two demo programs, serves the desk; Ctrl-C stops and checkpoints
pnpm test             # both tiers (vitest)
pnpm test:unit        # the unit tier
pnpm test:integration # the slow tier: a real Pi AgentSession on a real loopback socket, no creds
pnpm typecheck
```

`pnpm dev` runs `node src/bin.ts`, an Effect CLI (`effect/unstable/cli`) over the pure `boot`.
Node strips the TypeScript itself, so the kernel has no build step. Boot loads your config layers
(see "Your config"), registers their programs, launches the processes the graph plans, restores any
other checkpointed process from the project's `.tuval/`, prints the process table, binds the page
socket, serves the desk, and stays up until Ctrl-C (SIGINT or SIGTERM), which stops and checkpoints
every process and exits 0; a config that plans no process exits right after the report.

```
tuval [flags]
  --config file          Global config module (default: ~/.tuval/tuval.config.ts)
  --project directory    Project dir whose .tuval/ holds the project config and state (default: cwd)
  --no-page              Boot the kernel and the socket, but serve no page
  --page-port integer    Port for the page (default: a free one)
  --help, --version
```

`node src/bin.ts --config <module>` swaps the global layer, which is how the tests exercise the
refusals; `--project <dir>` runs against another project's `.tuval/`. A path named by either flag
must exist.

```
tuval: booted — 3 program(s), 6 spell(s) registered from …/apps/tuval/.tuval/tuval.config.ts; 3 process(es) live, 0 restored from …/apps/tuval/.tuval
tuval: process shell program=shell parent=- ports=- state=running@0
tuval: process counter program=counter parent=- ports=ticks:out(count/v1) state=running@0
tuval: process log program=log parent=counter ports=ticks:in(count/v1) state=running@0
tuval: transport on 127.0.0.1:58319
tuval: desk at http://127.0.0.1:5173/
tuval: running — Ctrl-C stops and checkpoints
count 1
count 2
```

Those are two ports on purpose — the socket and the page bind separately — and the transport admits
the page's origin as it starts, so the browser's attach goes through (#7560).

Open that URL and the desk is yours by keyboard: `<c-b> |` and `<c-b> -` split, `<c-b> h/j/k/l`
walk focus, `<c-b> N` makes a workspace and `<c-b> <c-h>` / `<c-b> <c-l>` walk them, `<c-b> z`
zooms, and `<c-b> :` opens the command line — `window:open log` fills the focused window with a demo
program. With the prefix unarmed every key belongs to the focused window's process.

Beside the shell (below), the box holds the demo counter and log (`src/demo/`, #7517): the counter
ticks once a second and announces each count on its `ticks` out-port, the log records what arrives on
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
`version: 1`, `programs`, an optional `graph`, and an optional `keys` (see "Spells"). A row is a
`Program` (`src/registry/program.ts`):
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
import {ProcessId} from "../src/process/process.ts";
import {wiredShellEffects} from "../src/shell/host/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../src/shell/program.ts";

export default {
	version: 1,
	programs: [
		shellProgram({effects: wiredShellEffects({shellProcessId: ProcessId.make(shellNode)})}),
		...demoPrograms({everyMs: 1000, write: (line) => Console.log(line)}),
	],
	graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
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

## Spells

A spell is one command anything can call by path: `window close`, `spell list`, `process spawn`.
It carries a sentence describing itself, an Effect `Schema` for its arguments, another for its
result, and the Effect that runs it — so the same definition is what the command line completes
against, what a key binding compiles to, and what a program calls over the wire. The kernel
registers its own list at boot (`help`, `spell list`, `spell describe`, `process spawn`,
`process send`, `process read`), and boot reports the total beside the program count.

A program row declares its own in a `spells` field, and each one is registered under the program's
id, so `echo`'s `repeat` is `echo repeat` and no program can collide with another or with the
kernel's list:

```ts
import {Effect, Schema} from "effect";
import {defineSpell} from "../src/commands/spell.ts";

const repeat = defineSpell({
	path: ["repeat"],
	describe: "Answer with the word it was given, doubled.",
	params: Schema.Struct({word: Schema.String}),
	result: Schema.Struct({word: Schema.String}),
	execute: (args) => Effect.succeed({word: `${args.word}${args.word}`}),
	capabilities: [],
});
```

A config's `keys` block binds a key to a command written the way a person types it. Each one is
compiled against the registry at boot, so a mistake is reported while you are looking at the config
rather than under a key you press hours later, and recovery is per binding: the ones that compile
run, and the one that does not is named with the module, the key, where in the command string
reading stopped, what was expected, and the nearest thing you may have meant.

```ts
export default {
	version: 1,
	programs: [...],
	keys: {"ctrl-h": "help", "ctrl-x": {command: "workspace next", repeat: true}},
} satisfies TuvalConfigInput;
```

`:help` lists every registered spell with its arguments and its own sentence — there is no help
text written anywhere, because a row's description is the spell's own. An agent asks the same
registry the same way: `spell list` describes every spell, `spell describe <path>` describes one,
including its parameters as JSON Schema, and calling one is the same `SpellCall` message the
command line sends. There is no second catalogue for programs to read, and
`src/commands/agent-proof.unit.test.ts` is the proof: a scripted program enumerates the registry
over the wire and calls every spell in it, generating each call's arguments from that spell's own
parameter schema.

Reading a config again replaces the registry and the compiled key bindings in one step, so a
reader never sees new spells beside bindings compiled against the old ones
(`src/reload-proof.unit.test.ts`). What a reload does not touch is the processes already running:
they keep going under the rows they were spawned from.

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

## Shell: the program picker

`src/shell/picker/` is what an empty window shows: the programs it can spawn, and the processes it
can attach to. It replaces Studio's `scratch` window (`monorepo/packages/studio/studio.ts`), which
was one hard-coded widget name every new pane opened onto.

```ts
const entries = yield* readEntries;                      // registry rows + live process rows
const frame = pickerFrame(windowId, entries, mountPicker());
const answer = pickerKey(windowId, entries, view, "<arrowdown>");
const msgs = yield* runPickerIntent(openProgram(windowId, programId), {shellProcessId});
// [{type: "window.bind", windowId, processId}] — one spawn, under the shell process
```

**Both lists are read fresh every mount** and the picker stores nothing: what it remembers is the
window's own view slot (a cursor and at most one refusal), so a second mount after a registry
change shows the second registry. **A program with no renderer never appears** — the founder's
ruling makes the renderer optional and a row without one headless: it runs and exposes ports and
cannot fill a window, so offering it would offer a choice that resolves to a blank pane.

**One handler ends both routes.** A chosen row and a command line both produce a `PickerIntent`,
and `runPickerIntent` is where each lands: `window:open <program>` spawns one process under the
shell process and dispatches `window.bind`; `window:attach <process-id>` binds a process already
running and spawns nothing, which is the door to one process in many windows. The two command rows
are declared here as `pickerCommands` and folded into the table by `src/shell/commands/`.

**Every refusal is a value in the window.** An unknown program id, a headless program, a process
that no longer resolves, a spawn that failed, an unreadable command line — each is a `PickerRefusal`
written to the view slot through `window.setView`, so the picker stays mounted and announces it.
Nothing here throws and nothing here fails an Effect.

`pickerFrame` is the render, as data: an ARIA listbox of two named groups, an accessible name on
every option, the active option named for `aria-activedescendant`, and the refusal on an assertive
live region. Movement answers the arrow keys and their vim and readline spellings (`j`/`k`,
`<c-n>`/`<c-p>`, Tab), clamps at both ends rather than wrapping, and Home/End jump. The frame names
colour by role token only, states `dark`, and reports `motion: "none"` unless the surface says
`prefers-reduced-motion` is off — selection is carried by a character marker beside the colour, so
no state is signalled by colour or by motion alone.

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

## Shell: the shell as a program

`src/shell/program.ts` is the whole of the shell's claim on the kernel: one registry row, one graph
node. There is no built-in shell and no special path — the desk is a `Program` exactly as the demo
counter is, registered through your own config module, and dropping its row and node is how you boot
without one.

```ts
shellProgram({effects}); // id "shell", core from src/shell/core/, no ports
shellGraphNode;          // {id: "shell", program: "shell", on: []} — a root
```

Its durability is the kernel's, unchanged: boot spawns the node once, the spawn opens the checkpoint
under the node's own id, and a second boot finds a snapshot there and restores instead of spawning
fresh — workspaces, layouts, focus and per-window view state come back byte-equal, and a snapshot
written under another definition version refuses the boot rather than fresh-booting over it. Nothing
under `src/shell/` opens a store, and a test asserts that no file there ever will.

The version is one of two checks a snapshot passes. The other is its shape: a checkpoint re-enters
the program as `unknown`, so `shellStateOf` runs `isShellState` over it — total through every
workspace, layout node, view slot and order entry — and a version-matched snapshot with a corrupt
interior reads as `null` rather than as a desk.

A restored window whose process id no longer resolves is **kept**: `windowBindings(state, live)`
answers `ProcessGone` for it and `Empty` for a window with no process, so the surface renders a
placeholder or the picker and never a window that silently vanished. That function is also where the
layout tree's plain-string window ids meet the window contract's branded ones (#7700) — one
conversion, through the brand's own constructor.

The core's Cmds are handed in as `effects`. This slice ships only `unwiredShellEffects`, which does
none of them and logs each drop at debug; the set that runs them against the kernel is
`wiredShellEffects` in `src/shell/host/`, and that is what the config registers.

## Shell: the browser surface

`src/shell/ui/` is the desk as a page — React 19, dark, and the only slice under `src/shell/` where
React or the DOM is allowed to appear. Every other slice forbids both in its own
`boundary.unit.test.ts`, and this one asserts the inverse: nothing outside `ui/` may import it.

It is also on the far side of the app's **browser/Node line**: nothing this slice reaches may import
`node:*`, because Vite externalizes those and the page throws at module load instead of rendering.
See [The two entry points](#the-two-entry-points) below.

```tsx
<Desk state={snapshot} dispatch={send} resolveMount={mounts} entries={picker} />
```

`state` is the shell process's own state as the transport delivered it, and `dispatch` puts a Msg
back on the wire. The surface stores nothing else — the command line being open, and the prefix
countdown, are the whole of its tab-ephemeral state, which is why two tabs on one shell show one
desk. A dropped socket does not clear the desk either: `useDeskAttachment` keeps the last snapshot
on screen while the page re-attaches.

The layout renders through `react-resizable-panels@4.12.3`: one `Group` per stack, one `Panel` per
child keyed by node id, and a drag lands as exactly one `layout.resize` Msg on release. Sizes
arriving from the kernel — another tab's drag — are pushed in through `setLayout`, because the
library reads `defaultLayout` once and a prop alone would never mirror. Zoom (`prefix z`, the new
`window:zoom` row) renders the one window alone and unzoom restores the split untouched. The rules
and the reasons are
[`.patterns/layout-tree-with-resizable-panels.md`](../../.patterns/layout-tree-with-resizable-panels.md).

Each window shows one of the window contract's three arms and no fourth: a bound host's program
renderer, the picker for an empty window, a placeholder for a gone process. The focused window is
marked twice over — a heavier border, and a glyph plus `aria-current` in its title row — because no
state here may be carried by colour alone.

There is one **application-level** keyboard listener, on the document, and it is the only thing that
dispatches `keys.press`. Two elements read their own keys and neither is a second shell listener:
the command line's input, and each `Separator`, whose arrow-key resizing the library attaches per
element.

Two of the core's Cmds are the surface's work and never cross the wire, which carries no Cmd frame:
opening the command line, and forwarding an unbound key to the focused window's renderer. The
surface derives both by running the shell's own pure `route` over the prefix snapshot the kernel
sent, so it cannot disagree with the core — an argument rather than a guard, tracked as
[#7781](https://github.com/kamp-us/phoenix/issues/7781).

## Shell: the assembled app

`src/shell/host/` runs the core's Cmds against the kernel and starts the socket, and `src/page/`
mounts the desk in a browser. `pnpm dev` is the whole thing in one process: boot, then the WebSocket
on an ephemeral port, then Vite through its Node API — which is why the launch token never touches
disk, since the middleware answering `/__tuval/launch` closes over the URL in memory.

Three of the eight Cmds are the kernel's: `openProgram` and `attachProcess` run the picker's one
handler, and `forwardKey` dispatches `{type: "key", key}` into the focused window's process. The
prefix countdown and the command line stay the surface's — a kernel handler returns its follow-ups
and cannot dispatch one a second later — and `config:reload` is still unwired (#7743).

`src/shell/proof/end-to-end.integration.test.ts` is the ticket's three proofs over the real socket
and the real demo programs: a scripted key sequence that splits, walks focus, switches workspaces,
opens a program from the picker and by `prefix :`, and shows one process in two windows with two view
slots; a stop and a second boot that brings the desk back byte-equal, duplicates no effect and yields
exactly one effect per new key; and a dropped socket whose re-attach shows the same desk and forwards
a key that reaches its process. The shape and its two rules are
[`.patterns/tuval-shell-assembly.md`](../../.patterns/tuval-shell-assembly.md).

Two things the page cannot do yet, both because the wire carries rows and no registry listing: its
picker offers running processes only (open by name through `prefix : window:open <program>`), and its
renderer table is keyed by program id rather than by the `renderer` reference a row declares.

## The two entry points

`src/bin.ts` runs under Node; `src/page/main.tsx` runs in a browser. They share slices but not import
surfaces, and the line between them is enforced by a second TypeScript project rather than by a lint
rule or a bundler plugin:

```bash
pnpm typecheck   # tsc -p tsconfig.json … && tsc -p tsconfig.browser.json …
```

`tsconfig.browser.json` is rooted at the browser entry alone and carries `"types": []` — no
`@types/node` in scope. So `node:crypto` resolves to nothing, and any module the entry reaches that
imports one is a plain `tsc` error. That error is the point: without it the import survives Vite,
which externalizes `node:*`, and the page throws at module load and paints black before React mounts
(#7836).

A slice both sides use keeps two barrels. `index.ts` is the whole slice; `browser.ts` is the half a
page may reach, and `index.ts` re-exports it — `src/shell/transport/browser.ts` leaves out the
handshake and the server, `src/shell/picker/browser.ts` leaves out `open.ts` and the kernel behind
it. A new Node-only module goes in `index.ts`, never `browser.ts`. The shape and the reasons are
[`.patterns/tuval-shell-assembly.md`](../../.patterns/tuval-shell-assembly.md).

## The AI agent slice

`src/ai-agent/` is the backend-blind half of running an AI agent as a Tuval program. Nothing under
it names Pi, Claude or any other backend: a row varies by the layer it is handed and by its identity,
and that is all (founder ruling, 2026-09-02). It is the half a second backend builds against.

**The service.** `TuvalAiAgent` (`src/ai-agent/service/`) is the one interface every backend
implements — `start`, `prompt`, `interrupt`, `answer`, `setMode`, `page`, and one `events` stream.
One subscription and one ordering: `AgentEvent` (`src/ai-agent/events.ts`) tags every kind —
`item`, `phase`, `permission`, `permission-resolved`, `mode`, `usage` — so the core folds a single
sequence rather than racing several (ruling 1, [#7570](https://github.com/kamp-us/phoenix/issues/7570)).
Each method carries its own `Schema.TaggedError`; a backend's own refusals are `reason`s inside
those, never tags that reach a caller. `ScriptedAiAgent.layer` is the deterministic implementation
every unit test runs on — a checked-in `AgentScript` is the whole backend, it talks to nothing, and
it holds no retry and no reconnect, so a test can prove the retry policy lives in the handlers'
declared data rather than hiding in a layer.

**The core.** `src/ai-agent/core/` is `ai-agent-session`, the one Demlik machine that drives any
layer. It holds no Effect and names no backend: each Cmd is the name of work a handler performs, and
the Sub is the name of the layer's event stream. Every refusal is data — a prompt outside `ready`, an
answer to a card nobody raised, a mode the agent does not offer each record an `AgentFailure` and
emit no Cmd, so the window renders the refusal instead of a crash taking the process with it.

**The handlers.** `src/ai-agent/handlers/` is the one generic handler set. Each handler yields the
service and calls one of its members; a layer's typed error becomes a `failed` Msg carrying the tag
as data, and the one thing that does fail a handler is a `PayloadRejected` — the route refused what
this program emitted, which is a wiring bug in the graph rather than the agent's answer. The Sub is
the outbound half: it dispatches each event as a Msg *and* runs the same fold the core runs over a
local projection seeded from the core's state, so the tail published on `transcript` is the tail the
core commits. Retry and deadline are three numbers on the row (`policy.ts`), not an `Effect.retry`
buried in a handler, and only `start` and the reconnect that repeats it are retried
([#7371](https://github.com/kamp-us/phoenix/issues/7371)).

**The ports.** `src/ai-agent/ports/` is the five ports that make a process an AI agent —
`transcript`, `transcript-page`, `prompt`, `permission`, `mode` — each with one nominal kind, one
payload predicate and one queue bound. Every payload is model-blind: no model name, cost, token
count, session id or backend type appears on one. A program playing both ends of a two-way port
names each end locally, and `compile` matches on the kind, so a cross-kind route still refuses.

**The history.** `src/ai-agent/history/` is pure and imports no Effect, no socket and no other
`ai-agent/` directory but `ports/`. The window is the live tail only — the newest whole exchanges
under both an item and a byte bound, plus what the bounds left out. Older history is backend-owned
(ruling 5): `planTranscriptPage` is a bound over a slice the backend already returned, walking older,
whole exchanges only, and Tuval keeps no second copy.

**The row.** `aiAgentProgram` (`src/ai-agent/program.ts`) assembles all of it into one program row:
the core, the eight port keys, the `receive` translations, the handlers and the Sub. A caller varies
`layer`, `cwd` and the identity. `PiAiAgent.layer` is the first layer to fill it; `ClaudeAiAgent` is
next ([#7618](https://github.com/kamp-us/phoenix/issues/7618)).

Shape and rationale: [tuval-program-row-effects.md](../../.patterns/tuval-program-row-effects.md).

## The Pi loopback server

`src/pi/server/` is the WebSocket server Pi 0.84.3 does not ship — the spike's `spike-server.mjs`
(#7469) hand-ported into Effect, plus the production half the spike had no need for. One server
per Pi process, on `127.0.0.1` and port 0: two Pi processes on one machine run two servers on two
ports and share nothing.

`PiServerService.layer()` is acquire/release scoped over a `PiSessionHost`. Closing its scope
closes every socket, ends every connection's fibers and disposes every session exactly once. The
service hands back the address, the dial URL and the capability token, all three `Redacted` where
they carry the token.

```ts
const layer = PiServerService.layer().pipe(
	Layer.provide(agentSessionHostLayer({modelRuntime, agentDir})),
);
```

**The wire.** Framed CBOR through `ClientMessageDecoder` / `encodeServerMessage`. Each request is
answered under its own id on its own fiber, so a slow `create` never holds up a later `list`.
Sessions are owned exclusively: a second connection attaching one is refused `session_locked`, a
missing one answers a structured `not_found`, and an `attach` from the connection that already
owns it is the reconnect — the previous lease is invalidated, a new one issued, and the transcript
comes back on the snapshot. Every change advances the session's revision and pushes a
`session_snapshot` to its owner; bursts coalesce, so revisions can skip but never go backwards.

**The production half** (#7465, founder ruling on #7567). The upgrade carries a per-launch
capability token — 32 random bytes as hex, minted per process spawn, in handler memory only, never
in Demlik state, the checkpoint or a log, and a fresh one after a restart. The handshake refuses a
missing or wrong token, a non-loopback `Host` and a non-loopback `Origin`, all before a WebSocket
exists and therefore before any frame is read. Every one of those inputs is attacker-controlled and
pre-auth, so the guard is total — no header and no request target can throw out of it, and the
`upgrade` listener answers a bare `400` under a `catch` if one ever does. A frame over the declared
inbound bound closes the socket with `1009`; a per-connection outbound queue over its bound closes
it with `1013`.

**`PiSessionHost`** is the seam. Above it, only protocol values; below it, the real `AgentSession`
and its JSONL `SessionManager` — the transcript lands under the session's own cwd, at
`<cwd>/.tuval/pi-sessions`. Everything crossing that seam is projected, never cast, per
[`.patterns/strict-wire-schema-projection.md`](../../.patterns/strict-wire-schema-projection.md).
`makeScriptedHost` in `fixtures.ts` is the same seam with no model behind it, which is what lets
the whole wire suite run in the unit tier.

## The Pi client

`src/pi/client/` is the dial side, in Node inside the same Pi process: the `ByteTransport` the
0.84.3 pin does not export, plus the lease handling around `PiClient`. Pi ships a Unix-socket
factory and nothing over a WebSocket, and Node 26 ships the WebSocket *client* as a global while
`ws` supplies the server half — so `webSocketTransportFactory` is ours, hand-derived from the
spike's `play.ts` (#7469) and shaped after the pin's own `unix.js`.

`PiClientService.layerWebSocket({url})` takes the server's dial URL, token included, and hands back
`connect`, `reconnect`, `createSession`, `attachSession`, `prompt`, `abort`, `snapshots` and
`disconnections`. Nothing below that surface returns a `Promise` or throws a Pi error class: every
rejection folds into one of four typed refusals — `SessionLocked`, `SessionNotFound`,
`Disconnected`, `ProtocolRefused` — in `refusals.ts`.

**Reconnect is explicit, and it does not preserve leases.** The pin invalidates every lease when the
connection drops, so a dropped socket is one `Disconnected` on the `disconnections` stream and
nothing else: no redial, no backoff, no queued call waiting on one. A caller reconnects and then
reacquires by session id, and the reacquired snapshot carries the transcript from before the drop.
Retry policy is the handlers' and stays declared data (#7371).

`fixtures.ts`'s `startProtocolServer` is an in-process `ws` listener speaking the real codec, which
is what lets the transport and the no-retry-loop proof run in the unit tier; the lock, the
not-found and the reacquire run against the loopback server on Pi's faux provider in
`pi-client.integration.test.ts`.

## The Pi AI agent layer

`src/pi/ai-agent/` is where Pi's protocol stops. `PiAiAgent.layer()` is a `Layer<TuvalAiAgent>` and
requires nothing (founder ruling 4, [#7570](https://github.com/kamp-us/phoenix/issues/7570)):
building it inside the process's scope stands up Pi's model runtime, the `PiSessionHost` over it,
one loopback server and one client, and closing that scope closes the client, the server and every
session exactly once. A process therefore holds no Pi value of its own — `PiAiAgentOptions` carries
plain strings, and `agentDir` is the only path it usually sets. Nothing on that surface is a Pi
type, and the per-launch token is unwrapped once, into the transport factory's closure, and reaches
no event, no method's answer and no log line.

`start({cwd, resume?})` is the caller's, not the layer's, so restore is "rebuild the layer, then
`start({cwd, resume: sessionId})`" — and that same call is the only way back after a drop. A dropped
socket fails `events` once with a `TransportError` and nothing dials again; the handlers decide.

Pi pushes whole snapshots, so `items.ts` folds each revision into the events that changed, keyed by
identities Pi guarantees — a tool row by its call id, so the result supersedes the running row it
belongs to ([snapshot-authoritative-to-delta-events.md](../../.patterns/snapshot-authoritative-to-delta-events.md)).
History is Pi's own: `page(before, limit)` reads the session's JSONL through
`SessionManager.getBranch()` and bounds it with the shared page planner, so Tuval keeps no second
copy. Pi raises no permission requests and offers no modes at this pin, so `answer` and `setMode`
refuse as data.
