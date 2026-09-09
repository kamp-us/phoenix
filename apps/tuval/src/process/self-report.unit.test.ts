/**
 * The latch is the kernel's, so the same program reads back the same title down every spawn path a
 * process can arrive by: the `process` spells, the graph, and a restore with no wiring at all.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option, type Scope} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {launch} from "../launch/launch.ts";
import {compile} from "../ports/compile.ts";
import {bound, isString} from "../ports/fixtures.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/ProcessPorts.ts";
import {open} from "../ports/wiring.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {toTableRow} from "../table/row.ts";
import {Processes} from "./Processes.ts";
import {ProcessTable} from "./ProcessTable.ts";
import type {ProcessHandle, ProcessId} from "./process.ts";
import {STATUS_PORT, statusPort, TITLE_PORT, titlePort} from "./self-report.ts";

type State = {readonly said: number};
type Say = {readonly type: "say"; readonly port: string; readonly line: string};
type Publish = {readonly type: "publish"; readonly port: string; readonly line: string};

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

/**
 * Publishes whatever it is told to, on whatever port it is told to. The emit's own failure is
 * ignored on purpose: an unwired port is one of the three paths under test, and the process has to
 * survive it for the latch to be readable afterwards.
 */
const reporter = (id: string, ports: AnyProgram["ports"]): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: defineMachine<State, Say, Publish, never, unknown>({
			init: (loaded) => [loaded ?? {said: 0}, []],
			update: {
				say: (state, msg) => [
					{said: state.said + 1},
					[{type: "publish", port: msg.port, line: msg.line}],
				],
			},
			interpret: {publish: () => Promise.resolve()},
		}),
		ports,
		handlers: {
			publish: (cmd: Publish) =>
				Effect.gen(function* () {
					yield* Effect.ignore((yield* ProcessPorts).emit(cmd.port, cmd.line));
					return [] as ReadonlyArray<Say>;
				}),
		},
		capabilities: [],
		identity: identity(id),
		placement: {host: "local"},
	}) satisfies Program<State, Say, Publish, never, unknown, unknown, ProcessPorts>;

const bothPorts = {[TITLE_PORT]: titlePort, [STATUS_PORT]: statusPort};

const speaker = reporter("speaker", bothPorts);
const mute = reporter("mute", {});
const sink: AnyProgram = {
	...reporter("sink", {lines: {kind: titlePort.kind, direction: "in", accepts: isString, bound}}),
	receive: {lines: (line: string): Say => ({type: "say", port: TITLE_PORT, line})},
};

const speakerNode = NodeId.make("speaker-node");
const sinkNode = NodeId.make("sink-node");

const graph: Graph = {
	nodes: [
		{
			id: speakerNode,
			program: speaker.id,
			on: [{port: TITLE_PORT, to: {node: sinkNode, port: "lines"}}],
		},
		{id: sinkNode, program: sink.id, on: []},
	],
};

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<
		A,
		E,
		Processes | ProcessTable | Registry | Checkpoints | SpawnedProcesses | Scope.Scope
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

const say = (handle: ProcessHandle, port: string, line: string) =>
	handle.dispatch({type: "say", port, line});

const reportOf = (id: ProcessId) =>
	Effect.gen(function* () {
		const row = yield* (yield* ProcessTable).get(id);
		return row.selfReport();
	});

describe("the kernel's title@1 / status@1 latch", () => {
	it.effect("holds the newest value of a process spawned through the process spells", () =>
		withKernel(
			[speaker],
			Effect.gen(function* () {
				const spawned = yield* SpawnedProcesses;
				const id = yield* spawned.spawn(speaker.id, Option.none());
				const handle = yield* Effect.map(
					Effect.flatMap(Processes, (processes) => processes.handle(id)),
					Option.getOrThrow,
				);
				yield* say(handle, TITLE_PORT, "speaker · fable");
				yield* say(handle, STATUS_PORT, "idle");
				assert.deepStrictEqual(yield* reportOf(id), {
					title: Option.some("speaker · fable"),
					status: Option.some("idle"),
				});
			}),
		),
	);

	it.effect("holds the newest value of a process launched from the graph", () =>
		withKernel(
			[speaker, sink],
			Effect.gen(function* () {
				const compiled = yield* compile(graph);
				const launched = yield* launch(compiled, yield* open(compiled));
				const node = launched.find((process) => process.node === speakerNode);
				assert.isDefined(node);
				yield* say(node!.handle, TITLE_PORT, "speaker · graph");
				assert.deepStrictEqual(
					(yield* reportOf(node!.handle.id)).title,
					Option.some("speaker · graph"),
				);
			}),
		),
	);

	// The restore path binds `unwired` ports (#7789), so every emit fails. The latch is what the
	// process said about itself and not what a route did with it, so the title still reads back.
	it.effect("holds a value the wiring refused to deliver", () =>
		withKernel(
			[speaker],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* processes.spawn(speaker.id, {
					services: Context.make(ProcessPorts, unwired(NodeId.make("orphan"))),
				});
				yield* say(handle, TITLE_PORT, "speaker · restored");
				assert.deepStrictEqual(
					(yield* reportOf(handle.id)).title,
					Option.some("speaker · restored"),
				);
			}),
		),
	);

	it.effect("reads back the second line, not the first", () =>
		withKernel(
			[speaker],
			Effect.gen(function* () {
				const spawned = yield* SpawnedProcesses;
				const id = yield* spawned.spawn(speaker.id, Option.none());
				const handle = yield* Effect.map(
					Effect.flatMap(Processes, (processes) => processes.handle(id)),
					Option.getOrThrow,
				);
				yield* say(handle, TITLE_PORT, "first");
				yield* say(handle, TITLE_PORT, "second");
				assert.deepStrictEqual((yield* reportOf(id)).title, Option.some("second"));
			}),
		),
	);

	it.effect(
		"leaves a program that declares neither port with neither value, and nothing throws",
		() =>
			withKernel(
				[mute],
				Effect.gen(function* () {
					const spawned = yield* SpawnedProcesses;
					const id = yield* spawned.spawn(mute.id, Option.none());
					const handle = yield* Effect.map(
						Effect.flatMap(Processes, (processes) => processes.handle(id)),
						Option.getOrThrow,
					);
					yield* say(handle, TITLE_PORT, "not mine to say");
					assert.deepStrictEqual(yield* reportOf(id), {
						title: Option.none(),
						status: Option.none(),
					});
					const projected = toTableRow(yield* (yield* ProcessTable).get(id));
					assert.deepStrictEqual(projected.title, Option.none());
					assert.deepStrictEqual(projected.status, Option.none());
				}),
			),
	);
});
