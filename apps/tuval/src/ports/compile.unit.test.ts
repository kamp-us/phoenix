import {assert, describe, it} from "@effect/vitest";
import {Effect, Option} from "effect";
import {type AnyProgram, ProgramId, ProgramNotFound} from "../registry/index.ts";
import {Registry} from "../registry/Registry.ts";
import {compile} from "./compile.ts";
import {
	DuplicateNodeId,
	IncompatibleRoute,
	InvalidBound,
	UndeclaredPort,
	UnknownNode,
	UnknownParent,
} from "./errors.ts";
import {consumer, isNumber, judge, producer, program} from "./fixtures.ts";
import type {Graph} from "./graph.ts";
import {NodeId} from "./graph.ts";

const compileWith = (rows: ReadonlyArray<AnyProgram>, graph: Graph) =>
	Effect.flip(Effect.provide(compile(graph), Registry.layer(rows)));

const node = (id: string, programId: string, on: Graph["nodes"][number]["on"] = []) => ({
	id: NodeId.make(id),
	program: ProgramId.make(programId),
	on,
});

const to = (nodeId: string, port: string) => ({node: NodeId.make(nodeId), port});

describe("ports.compile", () => {
	it.effect("compiles a compatible route into one normalized route carrying both program ids", () =>
		Effect.gen(function* () {
			const compiled = yield* Effect.provide(
				compile({
					nodes: [
						node("p", "producer", [{port: "ticks", to: to("c", "ticks")}]),
						node("c", "consumer"),
					],
				}),
				Registry.layer([producer, consumer()]),
			);
			assert.deepStrictEqual(compiled.routes, [
				{
					kind: "tick/v1",
					source: {node: "p", port: "ticks", program: "producer"},
					target: {node: "c", port: "ticks", program: "consumer"},
				},
			]);
			assert.deepStrictEqual(
				compiled.nodes.map((n) => n.id),
				["p", "c"],
			);
		}),
	);

	it.effect(
		"refuses an incompatible route before boot, naming both kinds and both program ids",
		() =>
			Effect.gen(function* () {
				const error = yield* compileWith([producer, judge], {
					nodes: [
						node("p", "producer", [{port: "ticks", to: to("j", "verdicts")}]),
						node("j", "judge"),
					],
				});
				assert.instanceOf(error, IncompatibleRoute);
				const incompatible = error as IncompatibleRoute;
				assert.strictEqual(incompatible.source.program, "producer");
				assert.strictEqual(incompatible.source.port, "ticks");
				assert.strictEqual(incompatible.source.kind, "tick/v1");
				assert.strictEqual(incompatible.target.program, "judge");
				assert.strictEqual(incompatible.target.port, "verdicts");
				assert.strictEqual(incompatible.target.kind, "verdict/v1");
				assert.strictEqual(
					error.message,
					'route producer.ticks -> judge.verdicts is incompatible: source kind "tick/v1" does not match target kind "verdict/v1"',
				);
			}),
	);

	it.effect(
		"refuses a route leaving a port the source program does not declare, naming port and program",
		() =>
			Effect.gen(function* () {
				const error = yield* compileWith([producer, consumer()], {
					nodes: [
						node("p", "producer", [{port: "beats", to: to("c", "ticks")}]),
						node("c", "consumer"),
					],
				});
				assert.instanceOf(error, UndeclaredPort);
				const undeclared = error as UndeclaredPort;
				assert.strictEqual(undeclared.program, "producer");
				assert.strictEqual(undeclared.port, "beats");
				assert.strictEqual(undeclared.direction, "out");
				assert.strictEqual(error.message, 'program "producer" declares no out-port "beats"');
			}),
	);

	it.effect("refuses a route into a port the target program does not declare", () =>
		Effect.gen(function* () {
			const error = yield* compileWith([producer, consumer()], {
				nodes: [
					node("p", "producer", [{port: "ticks", to: to("c", "beats")}]),
					node("c", "consumer"),
				],
			});
			assert.instanceOf(error, UndeclaredPort);
			const undeclared = error as UndeclaredPort;
			assert.strictEqual(undeclared.program, "consumer");
			assert.strictEqual(undeclared.port, "beats");
			assert.strictEqual(undeclared.direction, "in");
		}),
	);

	it.effect("an in-port is not an outbound port: routing from it is refused as undeclared", () =>
		Effect.gen(function* () {
			const error = yield* compileWith([producer, consumer()], {
				nodes: [node("c", "consumer", [{port: "ticks", to: to("c", "ticks")}])],
			});
			assert.instanceOf(error, UndeclaredPort);
			const undeclared = error as UndeclaredPort;
			assert.strictEqual(undeclared.program, "consumer");
			assert.strictEqual(undeclared.port, "ticks");
			assert.strictEqual(undeclared.direction, "out");
		}),
	);

	it.effect("refuses a route to a node the graph does not declare", () =>
		Effect.gen(function* () {
			const error = yield* compileWith([producer], {
				nodes: [node("p", "producer", [{port: "ticks", to: to("ghost", "ticks")}])],
			});
			assert.instanceOf(error, UnknownNode);
			const unknown = error as UnknownNode;
			assert.strictEqual(unknown.from, "p");
			assert.strictEqual(unknown.to, "ghost");
		}),
	);

	it.effect("refuses a node naming a program the registry does not hold", () =>
		Effect.gen(function* () {
			const error = yield* compileWith([producer], {nodes: [node("x", "missing")]});
			assert.instanceOf(error, ProgramNotFound);
		}),
	);

	it.effect("refuses a duplicate node id", () =>
		Effect.gen(function* () {
			const error = yield* compileWith([producer], {
				nodes: [node("p", "producer"), node("p", "producer")],
			});
			assert.instanceOf(error, DuplicateNodeId);
			assert.strictEqual((error as DuplicateNodeId).node, "p");
		}),
	);

	it.effect("refuses an in-port whose bound is not a positive integer", () =>
		Effect.gen(function* () {
			const unbounded = program("sink", {
				ticks: {
					kind: "tick/v1",
					direction: "in",
					accepts: isNumber,
					bound: {capacity: 0, overflow: "suspend"},
				},
			});
			const error = yield* compileWith([unbounded], {nodes: [node("s", "sink")]});
			assert.instanceOf(error, InvalidBound);
			const invalid = error as InvalidBound;
			assert.strictEqual(invalid.program, "sink");
			assert.strictEqual(invalid.port, "ticks");
			assert.strictEqual(invalid.capacity, 0);
		}),
	);

	it.effect("carries a node's parent when it is declared earlier, as none when it has one", () =>
		Effect.gen(function* () {
			const compiled = yield* Effect.provide(
				compile({
					nodes: [node("p", "producer"), {...node("c", "consumer"), parent: NodeId.make("p")}],
				}),
				Registry.layer([producer, consumer()]),
			);
			assert.deepStrictEqual(
				compiled.nodes.map((n) => n.parent),
				[Option.none(), Option.some("p")],
			);
		}),
	);

	it.effect(
		"refuses a parent the graph does not declare before the child, whether later or never",
		() =>
			Effect.gen(function* () {
				const later = yield* compileWith([producer, consumer()], {
					nodes: [{...node("c", "consumer"), parent: NodeId.make("p")}, node("p", "producer")],
				});
				assert.instanceOf(later, UnknownParent);
				const unknownParent = later as UnknownParent;
				assert.strictEqual(unknownParent.node, "c");
				assert.strictEqual(unknownParent.parent, "p");
				assert.strictEqual(
					later.message,
					'node "c" names parent "p", which the graph does not declare before it',
				);

				const never = yield* compileWith([consumer()], {
					nodes: [{...node("c", "consumer"), parent: NodeId.make("ghost")}],
				});
				assert.instanceOf(never, UnknownParent);
			}),
	);
});
