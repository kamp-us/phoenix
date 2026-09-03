import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Layer, Option, Stream} from "effect";
import {expectTypeOf} from "vitest";
import {compile} from "../ports/compile.ts";
import {PortNotWired} from "../ports/errors.ts";
import {bound, program} from "../ports/fixtures.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {open} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {AnyProgram} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {PROCESS_TABLE_KIND, ProcessTablePort, processTablePort} from "./ProcessTablePort.ts";
import {isTableEvent, type TableEvent, type TableRow} from "./row.ts";

const counter = program("counter", {
	ticks: {kind: "tick/v1", direction: "out", accepts: (p): p is number => typeof p === "number"},
	verdicts: {kind: "verdict/v1", direction: "in", accepts: (p): p is string => true, bound},
});

/** The kernel as a graph node: its only port is the table, declared like any program's. */
const kernel = program("kernel", {table: processTablePort});

/** A projection: one in-port of the table's kind, and no knowledge of any program. */
const projection = program("projection", {
	table: {kind: PROCESS_TABLE_KIND, direction: "in", accepts: isTableEvent, bound},
});

const counterId = ProgramId.make("counter");

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable | ProcessTablePort | Registry>,
) => {
	const registry = Registry.layer(rows);
	const processes = Processes.layer.pipe(Layer.provideMerge(registry));
	return body.pipe(Effect.provide(ProcessTablePort.layer.pipe(Layer.provideMerge(processes))));
};

/** Subscribe now, collect the next `count` events; the join is the wait. */
const collect = (changes: Stream.Stream<TableEvent>, count: number) =>
	Effect.forkChild(Stream.runCollect(Stream.take(changes, count)), {startImmediately: true});

describe("ProcessTablePort", () => {
	it.effect("each row carries id, program, parent, declared ports and a state summary", () =>
		withKernel(
			[counter],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const port = yield* ProcessTablePort;
				const root = yield* processes.spawn(counterId);
				const child = yield* processes.spawn(counterId, {parent: root.id});
				yield* child.dispatch({type: "tick"});

				const rows = yield* port.rows;
				assert.deepStrictEqual(
					rows.map((row) => row.id),
					[root.id, child.id],
				);
				const row = rows[1] as TableRow;
				assert.deepStrictEqual(Object.keys(row).sort(), [
					"id",
					"parentId",
					"ports",
					"programId",
					"stateSummary",
				]);
				assert.strictEqual(row.programId, counterId);
				assert.deepStrictEqual(row.parentId, Option.some(root.id));
				assert.deepStrictEqual(row.ports, {
					ticks: {kind: "tick/v1", direction: "out"},
					verdicts: {kind: "verdict/v1", direction: "in"},
				});
				assert.deepStrictEqual(row.stateSummary, {lifecycle: "running", revision: 1});
				assert.deepStrictEqual((rows[0] as TableRow).stateSummary, {
					lifecycle: "running",
					revision: 0,
				});
			}),
		),
	);

	it.effect("emits on spawn, on a state-summary change and on stop, each with the row", () =>
		withKernel(
			[counter],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const port = yield* ProcessTablePort;
				const events = yield* collect(port.changes, 3);

				const handle = yield* processes.spawn(counterId);
				yield* handle.dispatch({type: "tick"});
				yield* processes.stop(handle.id);

				const seen = yield* Fiber.join(events);
				assert.deepStrictEqual(
					seen.map((event) => event.kind),
					["spawned", "state-changed", "stopped"],
				);
				assert.deepStrictEqual(
					seen.map((event) => event.row.id),
					[handle.id, handle.id, handle.id],
				);
				assert.deepStrictEqual(
					seen.map((event) => event.row.stateSummary),
					[
						{lifecycle: "running", revision: 0},
						{lifecycle: "running", revision: 1},
						{lifecycle: "stopping", revision: 1},
					],
				);
				assert.deepStrictEqual(yield* port.rows, []);
			}),
		),
	);

	it.effect("delivers through the wiring to a projection's in-port, in order", () =>
		withKernel(
			[counter, kernel, projection],
			Effect.scoped(
				Effect.gen(function* () {
					const processes = yield* Processes;
					const port = yield* ProcessTablePort;
					const graph: Graph = {
						nodes: [
							{
								id: NodeId.make("k"),
								program: ProgramId.make("kernel"),
								on: [{port: "table", to: {node: NodeId.make("v"), port: "table"}}],
							},
							{id: NodeId.make("v"), program: ProgramId.make("projection"), on: []},
						],
					};
					const wiring = yield* open(yield* compile(graph));
					yield* Effect.forkScoped(port.feed(wiring, {node: NodeId.make("k"), port: "table"}), {
						startImmediately: true,
					});
					const inbox = yield* wiring.inbox({node: NodeId.make("v"), port: "table"});

					const handle = yield* processes.spawn(counterId);
					yield* handle.dispatch({type: "tick"});
					yield* processes.stop(handle.id);

					const received = yield* Stream.runCollect(Stream.take(Stream.fromQueue(inbox), 3));
					assert.deepStrictEqual(
						received.map((event) => (event as TableEvent).kind),
						["spawned", "state-changed", "stopped"],
					);
				}),
			),
		),
	);

	it.effect("no message on the port mutates the table: spawn and stop are unreachable", () =>
		withKernel(
			[counter, kernel, projection],
			Effect.scoped(
				Effect.gen(function* () {
					const port = yield* ProcessTablePort;
					const table = yield* ProcessTable;
					expectTypeOf<typeof port>().not.toHaveProperty("spawn");
					expectTypeOf<typeof port>().not.toHaveProperty("stop");
					expectTypeOf<typeof port>().not.toHaveProperty("dispatch");
					assert.deepStrictEqual(Object.keys(port).sort(), ["changes", "feed", "rows"]);

					assert.isFalse(processTablePort.accepts({type: "spawn", programId: counterId}));
					assert.isFalse(processTablePort.accepts({type: "stop", id: "any"}));

					const graph: Graph = {
						nodes: [
							{
								id: NodeId.make("k"),
								program: ProgramId.make("kernel"),
								on: [{port: "table", to: {node: NodeId.make("v"), port: "table"}}],
							},
							{id: NodeId.make("v"), program: ProgramId.make("projection"), on: []},
						],
					};
					const wiring = yield* open(yield* compile(graph));
					const refused = yield* wiring
						.emit({node: NodeId.make("v"), port: "table"}, {type: "spawn", programId: counterId})
						.pipe(Effect.flip);
					assert.instanceOf(refused, PortNotWired);
					assert.deepStrictEqual(yield* table.list, []);
					assert.deepStrictEqual(yield* port.rows, []);
				}),
			),
		),
	);

	it.effect("a consumer that never read the registry renders every row from the port alone", () => {
		const render = (row: TableRow): string => {
			const parent = Option.getOrElse(row.parentId, () => "-");
			const ports = Object.entries(row.ports)
				.map(([name, port]) => `${name}:${port.direction}:${port.kind}`)
				.join(",");
			return `${row.id} ${row.programId} ${parent} [${ports}] ${row.stateSummary.lifecycle}@${row.stateSummary.revision}`;
		};
		const ps: Effect.Effect<ReadonlyArray<string>, never, ProcessTablePort> = Effect.flatMap(
			ProcessTablePort,
			(port) => Effect.map(port.rows, (rows) => rows.map(render)),
		);
		expectTypeOf<Effect.Services<typeof ps>>().toEqualTypeOf<ProcessTablePort>();

		return withKernel(
			[counter],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const root = yield* processes.spawn(counterId);
				const child = yield* processes.spawn(counterId, {parent: root.id});
				yield* child.dispatch({type: "tick"});
				assert.deepStrictEqual(yield* ps, [
					`${root.id} counter - [ticks:out:tick/v1,verdicts:in:verdict/v1] running@0`,
					`${child.id} counter ${root.id} [ticks:out:tick/v1,verdicts:in:verdict/v1] running@1`,
				]);
			}),
		);
	});
});
