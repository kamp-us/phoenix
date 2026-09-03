import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type AnyProgram, ProgramId, ProgramNotFound} from "../registry/index.ts";
import {Registry} from "../registry/Registry.ts";
import {compile} from "./compile.ts";
import {
	DuplicateNodeId,
	IncompatibleRoute,
	InvalidBound,
	UndeclaredPort,
	UnknownNode,
} from "./errors.ts";
import {consumer, isNumber, judge, producer, program} from "./fixtures.ts";
import type {Graph} from "./graph.ts";
import {NodeId} from "./graph.ts";

const compileWith = (rows: ReadonlyArray<AnyProgram>, graph: Graph) =>
	Effect.runPromise(Effect.flip(Effect.provide(compile(graph), Registry.layer(rows))));

const node = (id: string, programId: string, on: Graph["nodes"][number]["on"] = []) => ({
	id: NodeId.make(id),
	program: ProgramId.make(programId),
	on,
});

const to = (nodeId: string, port: string) => ({node: NodeId.make(nodeId), port});

describe("ports.compile", () => {
	it("compiles a compatible route into one normalized route carrying both program ids", async () => {
		const compiled = await Effect.runPromise(
			Effect.provide(
				compile({
					nodes: [
						node("p", "producer", [{port: "ticks", to: to("c", "ticks")}]),
						node("c", "consumer"),
					],
				}),
				Registry.layer([producer, consumer()]),
			),
		);
		expect(compiled.routes).toEqual([
			{
				kind: "tick/v1",
				source: {node: "p", port: "ticks", program: "producer"},
				target: {node: "c", port: "ticks", program: "consumer"},
			},
		]);
		expect(compiled.nodes.map((n) => n.id)).toEqual(["p", "c"]);
	});

	it("refuses an incompatible route before boot, naming both kinds and both program ids", async () => {
		const error = await compileWith([producer, judge], {
			nodes: [
				node("p", "producer", [{port: "ticks", to: to("j", "verdicts")}]),
				node("j", "judge"),
			],
		});
		expect(error).toBeInstanceOf(IncompatibleRoute);
		expect(error).toMatchObject({
			source: {program: "producer", port: "ticks", kind: "tick/v1"},
			target: {program: "judge", port: "verdicts", kind: "verdict/v1"},
		});
		expect(error.message).toBe(
			'route producer.ticks -> judge.verdicts is incompatible: source kind "tick/v1" does not match target kind "verdict/v1"',
		);
	});

	it("refuses a route leaving a port the source program does not declare, naming port and program", async () => {
		const error = await compileWith([producer, consumer()], {
			nodes: [
				node("p", "producer", [{port: "beats", to: to("c", "ticks")}]),
				node("c", "consumer"),
			],
		});
		expect(error).toBeInstanceOf(UndeclaredPort);
		expect(error).toMatchObject({program: "producer", port: "beats", direction: "out"});
		expect(error.message).toBe('program "producer" declares no out-port "beats"');
	});

	it("refuses a route into a port the target program does not declare", async () => {
		const error = await compileWith([producer, consumer()], {
			nodes: [
				node("p", "producer", [{port: "ticks", to: to("c", "beats")}]),
				node("c", "consumer"),
			],
		});
		expect(error).toBeInstanceOf(UndeclaredPort);
		expect(error).toMatchObject({program: "consumer", port: "beats", direction: "in"});
	});

	it("an in-port is not an outbound port: routing from it is refused as undeclared", async () => {
		const error = await compileWith([producer, consumer()], {
			nodes: [node("c", "consumer", [{port: "ticks", to: to("c", "ticks")}])],
		});
		expect(error).toBeInstanceOf(UndeclaredPort);
		expect(error).toMatchObject({program: "consumer", port: "ticks", direction: "out"});
	});

	it("refuses a route to a node the graph does not declare", async () => {
		const error = await compileWith([producer], {
			nodes: [node("p", "producer", [{port: "ticks", to: to("ghost", "ticks")}])],
		});
		expect(error).toBeInstanceOf(UnknownNode);
		expect(error).toMatchObject({from: "p", to: "ghost"});
	});

	it("refuses a node naming a program the registry does not hold", async () => {
		const error = await compileWith([producer], {nodes: [node("x", "missing")]});
		expect(error).toBeInstanceOf(ProgramNotFound);
	});

	it("refuses a duplicate node id", async () => {
		const error = await compileWith([producer], {
			nodes: [node("p", "producer"), node("p", "producer")],
		});
		expect(error).toBeInstanceOf(DuplicateNodeId);
		expect(error).toMatchObject({node: "p"});
	});

	it("refuses an in-port whose bound is not a positive integer", async () => {
		const unbounded = program("sink", {
			ticks: {
				kind: "tick/v1",
				direction: "in",
				accepts: isNumber,
				bound: {capacity: 0, overflow: "suspend"},
			},
		});
		const error = await compileWith([unbounded], {nodes: [node("s", "sink")]});
		expect(error).toBeInstanceOf(InvalidBound);
		expect(error).toMatchObject({program: "sink", port: "ticks", capacity: 0});
	});
});
