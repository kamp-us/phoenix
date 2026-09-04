import {type Cmd, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Queue, type Scope} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {compile} from "../ports/compile.ts";
import {bound, isNumber} from "../ports/fixtures.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {open} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {NoReceiver} from "./errors.ts";
import {launch} from "./launch.ts";

type Seen = {readonly seen: ReadonlyArray<number>};
type Take = {readonly type: "take"; readonly n: number};
type Say = {readonly type: "say"; readonly n: number};
type Emit = {readonly type: "emit"; readonly n: number};

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

/** Emits every `say` on `out`; nothing else. */
const speaker: AnyProgram = {
	id: ProgramId.make("speaker"),
	core: defineMachine<Seen, Say, Emit, never, unknown>({
		init: (loaded) => [loaded ?? {seen: []}, []],
		update: {say: (state, msg) => [state, [{type: "emit", n: msg.n}]]},
		interpret: {emit: () => Promise.resolve()},
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
} satisfies Program<Seen, Say, Emit, never, unknown, unknown, ProcessPorts>;

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

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable | Registry | Checkpoints | Scope.Scope>,
) =>
	body.pipe(
		Effect.scoped,
		Effect.provide(
			Processes.layer.pipe(
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
