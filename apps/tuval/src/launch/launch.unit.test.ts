import type {Cmd} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {SpawnedProcesses} from "@kampus/tuval-sdk/kernel/commands/core/process";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {compile} from "@kampus/tuval-sdk/kernel/ports/compile";
import {bound, isNumber} from "@kampus/tuval-sdk/kernel/ports/fixtures";
import {type Graph, NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {ProcessPorts} from "@kampus/tuval-sdk/kernel/ports/ProcessPorts";
import {open} from "@kampus/tuval-sdk/kernel/ports/wiring";
import {PlannedProcesses} from "@kampus/tuval-sdk/kernel/process/PlannedProcesses";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {defineMachine} from "@kampus/tuval-sdk/kernel/registry/machine";
import {type AnyProgram, type Program, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Effect, Layer, Option, Queue, type Scope} from "effect";
import {NoReceiver} from "./errors.ts";
import {launch} from "./launch.ts";

type Seen = {readonly seen: ReadonlyArray<number>};
/** The speaker's state. `ended` is the child it was told about — see its `stopped` cell below. */
type Watched = Seen & {readonly ended: string | null};
type Take = {readonly type: "take"; readonly n: number};
type Say = {readonly type: "say"; readonly n: number};
type Emit = {readonly type: "emit"; readonly n: number};
type Ended = {readonly type: "stopped"; readonly process: string};

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

/**
 * Emits every `say` on `out`, and writes down the id of a child it is told ended. It is the graph's
 * parent node, so that `stopped` cell is what an adopted child's end has to reach (#9227): the
 * finalizer that delivers it hangs on `enrol`, which both `spawn` and `adopt` pass through, so a
 * planned node with a declared parent is heard from exactly as an ad-hoc child is.
 */
const speaker: AnyProgram = {
	id: ProgramId.make("speaker"),
	core: defineMachine<Watched, Say | Ended, Emit, never, unknown>({
		init: (loaded) => [loaded ?? {seen: [], ended: null}, []],
		update: {
			say: (state, msg) => [state, [{type: "emit", n: msg.n}]],
			stopped: (state, msg) => [{...state, ended: msg.process}, []],
		},
	}),
	ports: {out: {kind: "tick/v1", direction: "out", accepts: isNumber}},
	handlers: {
		emit: (cmd: Emit) =>
			Effect.gen(function* () {
				yield* (yield* ProcessPorts).emit("out", cmd.n);
				return [] as ReadonlyArray<Say>;
			}),
	},
	capabilities: [],
	identity: identity("speaker"),
	placement: {host: "local"},
} satisfies Program<Watched, Say | Ended, Emit, never, unknown, unknown, ProcessPorts>;

/** Records every number arriving on `in`; `receive` is what makes it a listener. */
const listener = (withReceiver: boolean): AnyProgram => ({
	id: ProgramId.make("listener"),
	core: defineMachine<Seen, Take, Cmd<never>, never, unknown>({
		init: (loaded) => [loaded ?? {seen: []}, []],
		update: {take: (state, msg) => [{seen: [...state.seen, msg.n]}, []]},
	}),
	ports: {in: {kind: "tick/v1", direction: "in", accepts: isNumber, bound}},
	...(withReceiver ? {receive: {in: (n: number): Take => ({type: "take", n})}} : {}),
	handlers: {},
	capabilities: [],
	identity: identity("listener"),
	placement: {host: "local"},
});

const speakerNode = NodeId.make("s");
const listenerNode = NodeId.make("l");

const graph: Graph = {
	nodes: [
		{
			id: speakerNode,
			program: speaker.id,
			on: [{port: "out", to: {node: listenerNode, port: "in"}}],
		},
		{id: listenerNode, program: ProgramId.make("listener"), parent: speakerNode, on: []},
	],
};

/** The pump delivers off the test's fiber; poll for its result rather than sleep a guess. */
const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let i = 0; i < 200 && !check(); i++) yield* Effect.sleep(5);
	});

/** `launch` enrols every node it spawns in `SpawnedProcesses` since #8944, so the kernel owes it. */
const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<
		A,
		E,
		| Processes
		| PlannedProcesses
		| ProcessTable
		| Registry
		| Checkpoints
		| SpawnedProcesses
		| Scope.Scope
	>,
) =>
	body.pipe(
		Effect.scoped,
		Effect.provide(
			SpawnedProcesses.layer({readTimeout: "50 millis"}).pipe(
				Layer.provideMerge(Processes.layer),
				Layer.provideMerge(Checkpoints.layer(memoryStores())),
				Layer.provideMerge(Registry.layer(rows)),
			),
		),
	);

describe("launch", () => {
	it.live(
		"spawns one process per node at the node's id and parent, wired both ways, delivering in order",
		() =>
			withKernel(
				[speaker, listener(true)],
				Effect.gen(function* () {
					const table = yield* ProcessTable;
					const wiring = yield* open(yield* compile(graph));
					const launched = yield* launch(yield* compile(graph), wiring);
					assert.deepStrictEqual(
						launched.map((p) => [p.node, p.handle.id, p.restored]),
						[
							["s", "s", false],
							["l", "l", false],
						],
					);
					const [s, l] = launched;
					assert.deepStrictEqual(l!.handle.parentId, Option.some(s!.handle.id));
					assert.deepStrictEqual(
						(yield* table.list).map((row) => [row.id, row.programId]),
						[
							["s", "speaker"],
							["l", "listener"],
						],
					);

					for (const n of [1, 2, 3, 4, 5]) yield* s!.handle.dispatch({type: "say", n});
					yield* eventually(() => (l!.handle.getState() as Seen).seen.length === 5);
					assert.deepStrictEqual(l!.handle.getState(), {seen: [1, 2, 3, 4, 5]});
				}),
			),
	);

	it.effect(
		"refuses a node whose program declares an in-port with no receiver, before any spawn",
		() =>
			withKernel(
				[speaker, listener(false)],
				Effect.gen(function* () {
					const table = yield* ProcessTable;
					const compiled = yield* compile(graph);
					const wiring = yield* open(compiled);
					const refused = yield* launch(compiled, wiring).pipe(Effect.flip);
					assert.instanceOf(refused, NoReceiver);
					assert.deepStrictEqual(
						{node: refused.node, program: refused.program, port: refused.port},
						{node: "l", program: "listener", port: "in"},
					);
					assert.strictEqual(
						refused.message,
						'node "l" runs program "listener", which declares in-port "in" but no receiver for it',
					);
					assert.deepStrictEqual(yield* table.list, []);
				}),
			),
	);

	/**
	 * The adopted half of #9227. `launch` hands `adopt` the node's declared parent, and the table
	 * hangs the same end-notice finalizer it hangs on an ad-hoc spawn — so a graph node that ends,
	 * for any reason, reaches the node that declared it. `it.live`, because the notice is forked and
	 * a test clock would never let that fiber run.
	 */
	it.live("hands a node's parent a `stopped` when the adopted child ends", () =>
		withKernel(
			[speaker, listener(true)],
			Effect.gen(function* () {
				const compiled = yield* compile(graph);
				const wiring = yield* open(compiled);
				const [s, l] = yield* launch(compiled, wiring);

				yield* l!.handle.stop;
				yield* eventually(() => (s!.handle.getState() as Watched).ended !== null);

				assert.strictEqual((s!.handle.getState() as Watched).ended, l!.handle.id);
			}),
		),
	);

	/**
	 * The record `Processes.remove` refuses on (#9446). It is written here because here is the only
	 * place the planned node ids exist — `compile(graph)` is a local in `src/boot.ts` and nothing
	 * downstream retains it — and it is the compiled graph's ids, never "was this id checkpointed":
	 * a restored process and a planned one both come back at their saved id.
	 */
	it.effect("declares its nodes as planned, so removing one is refused", () =>
		withKernel(
			[speaker, listener(true)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const planned = yield* PlannedProcesses;
				const compiled = yield* compile(graph);
				yield* launch(compiled, yield* open(compiled));

				assert.isTrue(yield* planned.isPlanned(ProcessId.make("s")));
				const refused = yield* Effect.flip(processes.remove(ProcessId.make("s")));
				assert.strictEqual(refused._tag, "tuval/ProcessIsPlanned");
				assert.strictEqual(
					refused.message,
					'process "s" is declared by the config graph, so boot would start it again; edit the config to remove it',
				);
				assert.deepStrictEqual(
					(yield* ProcessTable.use((table) => table.list)).map((row) => row.id),
					[ProcessId.make("s"), ProcessId.make("l")],
				);
			}),
		),
	);

	it.effect("a stopped process's pump stops with it; the queue keeps what arrives after", () =>
		withKernel(
			[speaker, listener(true)],
			Effect.gen(function* () {
				const compiled = yield* compile(graph);
				const wiring = yield* open(compiled);
				const [s, l] = yield* launch(compiled, wiring);
				yield* l!.handle.stop;
				yield* s!.handle.dispatch({type: "say", n: 7});
				const inbox = yield* wiring.inbox({node: listenerNode, port: "in"});
				assert.strictEqual(yield* Queue.size(inbox), 1);
			}),
		),
	);
});
