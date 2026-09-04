/**
 * The end-to-end proof (#7517): the two demo programs, from the rows the config registers and
 * the graph it exports, through `start` — compiled, launched, routed, stopped, booted again from
 * disk. Every assertion here is one the kernel must keep for a real program to trust it.
 */

import {readdirSync, readFileSync} from "node:fs";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Queue, Schema} from "effect";
import {start} from "../boot.ts";
import {IncompatibleRoute} from "../ports/errors.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {ProcessTablePort} from "../table/ProcessTablePort.ts";
import {counterId} from "./counter.ts";
import {counterNode, demoGraph, demoPrograms, logNode} from "./index.ts";
import {logId} from "./log.ts";

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const tempDir = Effect.acquireRelease(
	io(() => mkdtemp(join(tmpdir(), "tuval-e2e-"))),
	(dir) => Effect.ignore(io(() => rm(dir, {recursive: true, force: true}))),
);

/** One boot of the demo app over `stateDir`, with a probe behind the log's `write`. */
const bootDemo = (stateDir: string) =>
	Effect.gen(function* () {
		const lines = yield* Queue.unbounded<string>();
		const programs = demoPrograms({
			everyMs: null,
			write: (line) => Effect.asVoid(Queue.offer(lines, line)),
		});
		const started = yield* start({programs, graph: demoGraph, stateDir});
		const counter = started.launched.find((p) => p.node === counterNode)!;
		const log = started.launched.find((p) => p.node === logNode)!;
		const tick = counter.handle.dispatch({type: "tick"});
		const rows = ProcessTablePort.use((port) => port.rows).pipe(
			Effect.provideContext(started.kernel),
		);
		return {started, counter, log, tick, lines, rows};
	});

const tableShape = (
	kernelRows: Effect.Effect<
		ReadonlyArray<{id: string; programId: string; parentId: Option.Option<string>}>
	>,
) =>
	Effect.map(kernelRows, (rows) =>
		rows.map((row) => [row.id, row.programId, Option.getOrNull(row.parentId)]),
	);

describe("tuval end to end", () => {
	it.effect(
		"two demo processes from config, routed in order, stopped, booted again at their checkpointed state with no duplicated effect and one new effect per new input",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;

				yield* Effect.scoped(
					Effect.gen(function* () {
						const app = yield* bootDemo(stateDir);
						assert.deepStrictEqual(
							app.started.launched.map((p) => [p.node, p.handle.programId, p.restored]),
							[
								["counter", counterId, false],
								["log", logId, false],
							],
						);
						assert.deepStrictEqual(app.started.restored, []);
						assert.deepStrictEqual(app.log.handle.parentId, Option.some(app.counter.handle.id));
						assert.deepStrictEqual(yield* tableShape(app.rows), [
							["counter", "counter", null],
							["log", "log", "counter"],
						]);

						yield* app.tick;
						yield* app.tick;
						yield* app.tick;
						assert.deepStrictEqual(
							[
								yield* Queue.take(app.lines),
								yield* Queue.take(app.lines),
								yield* Queue.take(app.lines),
							],
							["count 1", "count 2", "count 3"],
						);
						assert.deepStrictEqual(app.counter.handle.getState(), {count: 3});
						assert.deepStrictEqual(app.log.handle.getState(), {lines: [1, 2, 3]});
					}),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const app = yield* bootDemo(stateDir);
						assert.deepStrictEqual(
							app.started.launched.map((p) => [p.node, p.restored]),
							[
								["counter", true],
								["log", true],
							],
						);
						assert.deepStrictEqual(app.started.restored, []);
						assert.deepStrictEqual(app.counter.handle.getState(), {count: 3});
						assert.deepStrictEqual(app.log.handle.getState(), {lines: [1, 2, 3]});
						assert.deepStrictEqual(yield* tableShape(app.rows), [
							["counter", "counter", null],
							["log", "log", "counter"],
						]);

						yield* app.tick;
						assert.strictEqual(yield* Queue.take(app.lines), "count 4");
						assert.strictEqual(yield* Queue.size(app.lines), 0);
						assert.deepStrictEqual(app.log.handle.getState(), {lines: [1, 2, 3, 4]});
					}),
				);
			}),
	);

	it.effect(
		"an incompatible route is refused before boot, naming both kinds, with nothing spawned or written",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;
				const sink: AnyProgram = {
					...demoPrograms({everyMs: null, write: () => Effect.void})[1]!,
					id: ProgramId.make("sink"),
					ports: {
						ticks: {
							kind: "text/v1",
							direction: "in",
							accepts: (p): p is string => typeof p === "string",
							bound: {capacity: 1, overflow: "suspend"},
						},
					},
				};
				const graph: Graph = {
					nodes: [
						{
							id: counterNode,
							program: counterId,
							on: [{port: "ticks", to: {node: NodeId.make("sink"), port: "ticks"}}],
						},
						{id: NodeId.make("sink"), program: sink.id, on: []},
					],
				};
				const programs = [demoPrograms({everyMs: null, write: () => Effect.void})[0]!, sink];
				const refused = yield* start({programs, graph, stateDir}).pipe(Effect.flip, Effect.scoped);
				assert.instanceOf(refused, IncompatibleRoute);
				assert.deepStrictEqual([refused.source.kind, refused.target.kind], ["count/v1", "text/v1"]);
				assert.include(refused.message, "count/v1");
				assert.include(refused.message, "text/v1");
				assert.deepStrictEqual(yield* io(() => readdir(stateDir)), []);
			}),
	);

	it("the demo programs import only the kernel's ports and registry slices, Demlik and Effect", () => {
		const dir = import.meta.dirname;
		const allowed = /^(effect|@demlik\/tea|\.\/[a-z]+\.ts|\.\.\/(ports|registry)\/[A-Za-z]+\.ts)$/;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers.filter((s) => !allowed.test(s)).map((s) => `${name}: ${s}`);
			});
		assert.deepStrictEqual(offenders, []);
	});
});
