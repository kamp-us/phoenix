import {readFileSync} from "node:fs";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema} from "effect";
import {expect, expectTypeOf} from "vitest";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {ProcessPorts} from "../ports/ProcessPorts.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type ProcessHandle, ProcessId} from "../process/process.ts";
import {ProcessSelf} from "../process/self.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {ArgUnfilled, programArgs} from "./args.ts";
import {type ArrivalEvent, defineProgram} from "./define-program.ts";
import {emit, send, spawn, stop} from "./effect.ts";
import {port} from "./port.ts";
import {Program, ShapeMismatch, type ShapeSource} from "./shape.ts";

const Count = Schema.Number;
const Review = Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean});

interface CounterState {
	readonly count: number;
}

/**
 * The whole authored surface in one program: an in-port, an out-port, a request port, an event of
 * the author's own, and an effect. Nothing on it names Demlik, Effect, Scope or the row's generics.
 */
const counter = defineProgram({
	id: "counter",
	ports: {
		ticks: port.in(Count),
		announced: port.out(Count),
		review: port.request(Review, Count),
	},
	init: (): CounterState => ({count: 0}),
	update: {
		ticks: (state, event) => [
			{count: state.count + event.payload},
			[emit("announced", state.count + event.payload)],
		],
		review: (state) => [state, []],
		reset: (state: CounterState) => [{count: state.count * 0}, []],
	},
});

/** The row erases its own generics, so a test reading one back names the shape it wants. */
const receiverFor = (row: AnyProgram, name: string): ((payload: unknown) => unknown) => {
	const receive = row.receive as
		| Readonly<Record<string, (payload: unknown) => unknown>>
		| undefined;
	const receiver = receive?.[name];
	if (receiver === undefined) throw new Error(`no receiver for "${name}"`);
	return receiver;
};

const cellFor = (
	row: AnyProgram,
	event: string,
): ((state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]) => {
	const cells = row.core.update as Readonly<
		Record<string, (state: unknown, event: unknown) => readonly [unknown, ReadonlyArray<unknown>]>
	>;
	const cell = cells[event];
	if (cell === undefined) throw new Error(`no update cell for "${event}"`);
	return cell;
};

const portFor = (row: AnyProgram, name: string) => {
	const compiled = row.ports[name];
	if (compiled === undefined) throw new Error(`no port "${name}"`);
	return compiled;
};

const runEffect = (row: AnyProgram, cmd: {readonly type: string}) => {
	const handlers = row.handlers as Readonly<
		Record<string, (cmd: unknown) => Effect.Effect<ReadonlyArray<unknown>, unknown, any>>
	>;
	const handler = handlers[cmd.type];
	if (handler === undefined) throw new Error(`no handler for "${cmd.type}"`);
	return handler(cmd);
};

/** The one out-port emit the emit handler asks for, captured with no desk behind it. */
const capturingPorts = (emitted: Array<readonly [string, unknown]>) =>
	ProcessPorts.of({
		emit: (portName, payload) =>
			Effect.sync(() => {
				emitted.push([portName, payload]);
				return [];
			}),
	});

describe("authoring.defineProgram", () => {
	it("answers a row the registry's own type accepts", () => {
		const row: AnyProgram = counter;
		expect(row.id).toBe(ProgramId.make("counter"));
		expect(Object.keys(row.ports).sort()).toEqual(["announced", "review", "ticks"]);
		expect(row.capabilities).toEqual([]);
		expect(row.placement).toEqual({host: "local"});
		expect(row.identity).toEqual({
			package: "@kampus/tuval",
			program: "counter",
			version: "0.0.0",
			digest: "authored:counter",
		});
	});

	it("fills `interpret` itself, so no authored program carries one", () => {
		expect(Object.keys(counter.core.interpret ?? {}).sort()).toEqual([
			"ask",
			"emit",
			"reply",
			"send",
			"spawn",
			"stop",
		]);
	});

	it("carries a receiver for every arriving port, and none for an out-port", () => {
		// A request port arrives on the declaring side, so it owes a receiver as an in-port does.
		expect(Object.keys(counter.receive ?? {}).sort()).toEqual(["review", "ticks"]);
		expect(receiverFor(counter, "ticks")).toBeTypeOf("function");
		expect(receiverFor(counter, "review")).toBeTypeOf("function");
	});

	it("hands an arriving payload to the matching update cell, decoded", () => {
		const arrival = receiverFor(counter, "ticks")(3);
		expect(arrival).toEqual({type: "ticks", payload: 3});

		const [next, effects] = cellFor(counter, "ticks")({count: 1}, arrival);
		expect(next).toEqual({count: 4});
		expect(effects).toEqual([{type: "emit", port: "announced", payload: 4}]);
	});

	it("refuses a payload the port's schema rejects before any cell can read it", () => {
		expect(portFor(counter, "ticks").accepts(3)).toBe(true);
		expect(portFor(counter, "ticks").accepts("3")).toBe(false);
		expect(portFor(counter, "review").accepts({pr: 8728, urgent: true})).toBe(true);
		expect(portFor(counter, "review").accepts({pr: "8728", urgent: true})).toBe(false);
	});

	it("starts a fresh process on `init` and hands a restored one its checkpoint untouched", () => {
		expect(counter.core.init(null, undefined)).toEqual([{count: 0}, []]);
		// Demlik refuses a rehydrating `init` that emits Cmds, so the loaded branch emits none.
		expect(counter.core.init({count: 9}, undefined)).toEqual([{count: 9}, []]);
	});

	it("infers the state and the arriving event end to end", () => {
		defineProgram({
			id: "inferred",
			ports: {ticks: port.in(Count), review: port.request(Review, Count)},
			init: (): CounterState => ({count: 0}),
			update: {
				ticks: (state, event) => {
					expectTypeOf(state).toEqualTypeOf<CounterState>();
					expectTypeOf(state).not.toBeAny();
					expectTypeOf(event).toEqualTypeOf<ArrivalEvent<"ticks", number>>();
					expectTypeOf(event).not.toBeAny();
					expectTypeOf(event.payload).toEqualTypeOf<number>();
					return [state, []];
				},
				review: (state, event) => {
					expectTypeOf(event.payload).toEqualTypeOf<{
						readonly pr: number;
						readonly urgent: boolean;
					}>();
					return [state, []];
				},
			},
		});
	});

	it("stays reachable by spread for every field the layer does not sugar", () => {
		const row = {
			...counter,
			checkpointWorthy: () => false,
			restorable: (raw: unknown) => raw !== null,
		} satisfies AnyProgram;
		expect(row.checkpointWorthy()).toBe(false);
		expect(row.restorable(null)).toBe(false);
		expect(row.core).toBe(counter.core);
		expect(row.handlers).toBe(counter.handlers);
		expect(row.id).toBe(counter.id);
	});

	it.effect("runs an authored `emit` through ProcessPorts", () =>
		Effect.gen(function* () {
			const emitted: Array<readonly [string, unknown]> = [];
			const events = yield* runEffect(counter, emit("announced", 4)).pipe(
				Effect.provideService(ProcessPorts, capturingPorts(emitted)),
			);
			assert.deepStrictEqual(emitted, [["announced", 4]]);
			assert.deepStrictEqual(events, []);
		}),
	);

	it.effect("runs an authored `spawn` and `send` through the process spells", () =>
		Effect.gen(function* () {
			const sent: Array<readonly [ProcessId, string, unknown]> = [];
			const child = ProcessId.make("process-child");
			const self = ProcessId.make("process-self");
			const parents: Array<Option.Option<ProcessId>> = [];
			const spells = SpawnedProcesses.of({
				spawn: (_program, parent) =>
					Effect.sync(() => {
						parents.push(parent);
						return child;
					}),
				send: (process, portName, payload) =>
					Effect.sync(() => {
						sent.push([process, portName, payload]);
						return {delivered: true, evicted: 0};
					}),
				ask: () => Effect.die("this test asks nothing"),
				answer: () => Effect.die("this test answers nothing"),
				read: () => Effect.succeed(Option.none()),
			});

			const spawnedEvents = yield* Effect.scoped(
				runEffect(counter, spawn({programId: "reviewer", out: {}})).pipe(
					Effect.provideService(SpawnedProcesses, spells),
					Effect.provideServiceEffect(
						ProcessSelf,
						Effect.map(Effect.scope, (scope) => ({id: self, scope, state: () => undefined})),
					),
				),
			);
			assert.deepStrictEqual(spawnedEvents, [
				{type: "spawned", process: child, program: "reviewer"},
			]);
			// The handler stamps the parent off `ProcessSelf` and the effect carries no id (#8757).
			assert.deepStrictEqual(parents, [Option.some(self)]);

			const sentEvents = yield* runEffect(counter, send({process: child, port: "pr"}, 8728)).pipe(
				Effect.provideService(SpawnedProcesses, spells),
			);
			assert.deepStrictEqual(sent, [[child, "pr", 8728]]);
			assert.deepStrictEqual(sentEvents, []);
		}),
	);

	it.effect("runs an authored `stop` through Processes and answers `stopped`", () =>
		Effect.gen(function* () {
			const child = ProcessId.make("process-child");
			const halted: Array<ProcessId> = [];
			const processes = Processes.of({
				spawn: () => Effect.die("this test spawns through no kernel"),
				stop: (id) =>
					Effect.sync(() => {
						halted.push(id);
					}),
				handle: () => Effect.succeed(Option.none<ProcessHandle>()),
			});

			const events = yield* runEffect(counter, stop(child)).pipe(
				Effect.provideService(Processes, processes),
			);
			assert.deepStrictEqual(halted, [child]);
			assert.deepStrictEqual(events, [{type: "stopped", process: child}]);
		}),
	);
});

/**
 * What a `spawn` on a program-valued arg reaches (#8762). The ref an author writes `spawn` against
 * carries the arg's own service key, not a program id, so the claim under test is that the registry
 * is asked for the program the *config* filled that arg with — and that the two other outcomes, an
 * arg filled with nothing and an arg filled with a program the registry does not hold, refuse by
 * name rather than starting something.
 */
const Prompt = Schema.Struct({pr: Schema.Number});
const Verdict = Schema.Struct({verdict: Schema.String});
const reviewerShape = Program.shape({in: {prompt: Prompt}, out: {result: Verdict}});
const dispatcherArgs = programArgs("dispatcher", {reviewer: reviewerShape});

/**
 * The authored record, not the compiled row: a `ShapeSource` publishes its own port declarations
 * and the row erases them to predicates, which is why a config cannot yet fill an arg with a
 * shipped row (`./shape.ts`, #8887).
 */
const reviewerProgram = {
	id: "arg-filled-reviewer",
	ports: {prompt: port.in(Prompt), result: port.out(Verdict)},
	init: (): Record<string, never> => ({}),
	update: {prompt: (state: Record<string, never>) => [state, []] as const},
};

const reviewerRow = defineProgram(reviewerProgram);

/** One cell whose whole answer is a spawn of the arg, registered with or without a fill. */
const dispatcher = (fill?: {readonly reviewer: ShapeSource}) =>
	defineProgram({
		id: "dispatcher",
		args: dispatcherArgs,
		...(fill === undefined ? {} : {fill}),
		init: (): Record<string, never> => ({}),
		update: {
			hatch: (state: Record<string, never>) => [
				state,
				[spawn(dispatcherArgs.reviewer, {on: {result: "reviewed"}})],
			],
		},
	});

/** A registry that holds both rows, so what the spawn asks for is answered or refused for real. */
const kernel = (rows: ReadonlyArray<AnyProgram>) =>
	SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(memoryStores()))),
	);

/** Spawn the dispatcher as a root and make it hatch. The process table is the answer. */
const hatched = (rows: ReadonlyArray<AnyProgram>) =>
	Effect.gen(function* () {
		const spawner = yield* SpawnedProcesses;
		const parent = yield* spawner.spawn(ProgramId.make("dispatcher"), Option.none());
		const handle = Option.getOrThrow(yield* Processes.use((processes) => processes.handle(parent)));
		yield* handle.dispatch({type: "hatch"});
		const table = yield* ProcessTable.use((rows) => rows.list);
		return table.filter((row) => row.id !== parent).map((row) => row.programId);
	}).pipe(Effect.provide(kernel(rows)));

describe("authoring.defineProgram spawning through a program-valued arg", () => {
	it.effect("asks the registry for the program the config filled the arg with", () =>
		Effect.gen(function* () {
			const children = yield* hatched([dispatcher({reviewer: reviewerProgram}), reviewerRow]);

			assert.deepStrictEqual(children, [ProgramId.make("arg-filled-reviewer")]);
		}),
	);

	it.effect("answers `spawned` with that same resolved id, never the arg key", () =>
		Effect.gen(function* () {
			const asked: Array<ProgramId> = [];
			const child = ProcessId.make("process-reviewer");
			const events = yield* Effect.scoped(
				runEffect(
					dispatcher({reviewer: reviewerProgram}),
					spawn(dispatcherArgs.reviewer, {on: {result: "reviewed"}}),
				).pipe(
					Effect.provideService(
						SpawnedProcesses,
						SpawnedProcesses.of({
							spawn: (program) =>
								Effect.sync(() => {
									asked.push(program);
									return child;
								}),
							send: () => Effect.die("this test sends nothing"),
							ask: () => Effect.die("this test asks nothing"),
							answer: () => Effect.die("this test answers nothing"),
							read: () => Effect.succeed(Option.none()),
						}),
					),
					Effect.provideServiceEffect(
						ProcessSelf,
						Effect.map(Effect.scope, (scope) => ({
							id: ProcessId.make("process-dispatcher"),
							scope,
							state: () => undefined,
						})),
					),
				),
			);

			assert.deepStrictEqual(asked, [ProgramId.make("arg-filled-reviewer")]);
			assert.deepStrictEqual(events, [
				{type: "spawned", process: child, program: "arg-filled-reviewer"},
			]);
		}),
	);

	it.effect("refuses when the registration filled the arg with nothing", () =>
		Effect.gen(function* () {
			const refusal = yield* Effect.flip(
				Effect.scoped(
					runEffect(dispatcher(), spawn(dispatcherArgs.reviewer, {on: {result: "reviewed"}})).pipe(
						Effect.provideService(
							SpawnedProcesses,
							SpawnedProcesses.of({
								spawn: () => Effect.die("an unfilled arg names no program to spawn"),
								send: () => Effect.die("this test sends nothing"),
								ask: () => Effect.die("this test asks nothing"),
								answer: () => Effect.die("this test answers nothing"),
								read: () => Effect.succeed(Option.none()),
							}),
						),
						Effect.provideServiceEffect(
							ProcessSelf,
							Effect.map(Effect.scope, (scope) => ({
								id: ProcessId.make("process-dispatcher"),
								scope,
								state: () => undefined,
							})),
						),
					),
				),
			);

			assert.instanceOf(refusal, ArgUnfilled);
			assert.strictEqual((refusal as ArgUnfilled).arg, "tuval/arg/dispatcher/reviewer");
		}),
	);

	it.effect("refuses at the registry, under the filled program's id, when nothing holds it", () =>
		Effect.gen(function* () {
			// The reviewer row is left out of the registry on purpose: the refusal names what the
			// registry was actually asked for, which is the whole of what #8762 is about.
			const refusal = yield* Effect.flip(hatched([dispatcher({reviewer: reviewerProgram})]));

			const cause = (refusal as {readonly cause?: {readonly _tag?: string; program?: string}})
				.cause;
			assert.strictEqual(cause?._tag, "tuval/commands/UnknownProgram");
			assert.strictEqual(cause?.program, "arg-filled-reviewer");
		}),
	);

	it("refuses a fill that does not fit the declared shape, at definition time", () => {
		expect(() => dispatcher({reviewer: {id: "mute", ports: {prompt: port.in(Prompt)}}})).toThrow(
			ShapeMismatch,
		);
	});

	it("leaves a literal program id alone, so a shipped program takes the same path", () => {
		// No arg key, so nothing is resolved and the row keeps the shared handler record.
		expect(counter.handlers).toBe(reviewerRow.handlers);
		expect(spawn({programId: "counter", out: {}}).program).toBe("counter");
	});
});

/**
 * The seam #8716's four field children share. Each adds one key to `FIELD_COMPILERS` and edits no
 * other child's line, so the record is held to one key per line: a multi-line entry is the merge
 * conflict the next child would hit, and this test is what refuses one.
 */
describe("authoring.defineProgram field-compiler seam", () => {
	it("holds FIELD_COMPILERS to one key per line", () => {
		const source = readFileSync(new URL("./define-program.ts", import.meta.url), "utf8");
		const record = source.match(
			/export const FIELD_COMPILERS = \{\n(?<body>[\s\S]*?)\n\} satisfies FieldCompilers;/,
		);
		const body = record?.groups?.body;
		expect(body).toBeTypeOf("string");
		const lines = (body ?? "").split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(line).toMatch(/^\t[A-Za-z]+: .+,$/);
		}
	});
});
