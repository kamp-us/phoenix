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
pnpm test             # both tiers (vitest)
pnpm test:unit        # the unit tier
pnpm test:integration # the slow tier: a real Pi AgentSession on a real loopback socket, no creds
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
tuval: booted — 2 program(s), 6 spell(s) registered from …/apps/tuval/.tuval/tuval.config.ts; 2 process(es) live, 0 restored from …/apps/tuval/.tuval
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

`src/pi/ai-agent/` is where Pi's protocol stops. `PiAiAgent.layer()` is a `TuvalAiAgent` over the
loopback server and the client above it: building it stands up one server, dials one client and
holds both against the scope it was built in, so closing that scope closes the client, the server
and every session exactly once. Nothing on its surface is a Pi type, and the per-launch token is
unwrapped once, into the transport factory's closure, and reaches no event, no method's answer and
no log line.

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
