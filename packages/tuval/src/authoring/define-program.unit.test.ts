import {readFileSync} from "node:fs";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema} from "effect";
import {expect, expectTypeOf} from "vitest";
import {SessionOpening} from "../ai-agent/opening.ts";
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
import {
	type Answer,
	type ArrivalEvent,
	defineProgram,
	program,
	type RequestArrivalEvent,
} from "./define-program.ts";
import {
	emit,
	type ProgramEffect,
	type Spawned,
	type Stopped,
	send,
	spawn,
	stop,
	stopped,
} from "./effect.ts";
import {port} from "./port.ts";
import {Program, ShapeMismatch, type ShapeSource} from "./shape.ts";
import type {ProgramEvent} from "./view.ts";
import type {WindowHost} from "./window.ts";

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
			package: "@kampus/tuval-sdk",
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
				adopt: () => Effect.die("this test adopts nothing"),
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

	it.effect("provides an authored cwd to the spawned child as a fresh session opening", () =>
		Effect.gen(function* () {
			const child = ProcessId.make("process-child");
			const openings: Array<Option.Option<{readonly cwd: string; readonly resume: string | null}>> =
				[];
			const spells = SpawnedProcesses.of({
				spawn: () =>
					Effect.gen(function* () {
						openings.push(yield* Effect.serviceOption(SessionOpening));
						return child;
					}),
				send: () => Effect.die("this test sends nothing"),
				adopt: () => Effect.die("this test adopts nothing"),
				ask: () => Effect.die("this test asks nothing"),
				answer: () => Effect.die("this test answers nothing"),
				read: () => Effect.succeed(Option.none()),
			});
			const self = ProcessId.make("process-self");

			yield* Effect.scoped(
				runEffect(
					counter,
					spawn({programId: "reviewer", out: {}}, {cwd: "/worktrees/reviewer"}),
				).pipe(
					Effect.provideService(SpawnedProcesses, spells),
					Effect.provideServiceEffect(
						ProcessSelf,
						Effect.map(Effect.scope, (scope) => ({id: self, scope, state: () => undefined})),
					),
				),
			);

			assert.deepStrictEqual(openings.map(Option.getOrUndefined), [
				{cwd: "/worktrees/reviewer", resume: null},
			]);
		}),
	);

	// `stopped` is no longer this handler's answer (#9227). The child's own end is the single producer
	// of it, so the parent hears back on a later dispatch and hears back exactly once — which the
	// real-kernel test at the bottom of this file is what proves.
	it.effect(
		"runs an authored `stop` through Processes.remove and answers no event of its own",
		() =>
			Effect.gen(function* () {
				const child = ProcessId.make("process-child");
				const halted: Array<ProcessId> = [];
				const processes = Processes.of({
					spawn: () => Effect.die("this test spawns through no kernel"),
					// The authored effect goes through the durable removal since #9446: a `stop` that only
					// closed the Scope left the child in the manifest, so this double dies on it.
					stop: () => Effect.die("an authored `stop` removes; it does not stop and leave the row"),
					remove: (id) =>
						Effect.sync(() => {
							halted.push(id);
						}),
					handle: () => Effect.succeed(Option.none<ProcessHandle>()),
				});

				const events = yield* runEffect(counter, stop(child)).pipe(
					Effect.provideService(Processes, processes),
				);
				assert.deepStrictEqual(halted, [child]);
				assert.deepStrictEqual(events, []);
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
							adopt: () => Effect.die("this test adopts nothing"),
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
								adopt: () => Effect.die("this test adopts nothing"),
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

/**
 * The child-exit edge through the real kernel (#9227). Everything above this point either drives a
 * handler with a stub `SpawnedProcesses` or feeds an event by hand; what is under test here is that
 * a `stopped` arrives in a spawner's inbox at all — so the programs below run on the same
 * `SpawnedProcesses` + `Processes` layer the box boots, and the only thing the test does by hand is
 * end the child.
 *
 * Both endings are checked, because #9227's change is that they became one path: a child ended from
 * outside, and a child the parent itself stopped. The second is the one that must not double-count —
 * `stopHandler` answering `stopped` *and* the child's exit delivering it would have been two events
 * for one end, so `stops` is asserted exactly, not merely non-zero.
 */
const watcherArgs = programArgs("watcher", {reviewer: reviewerShape});

interface WatcherState {
	readonly child: ProcessId | null;
	readonly ended: ProcessId | null;
	readonly stops: number;
}

const watcher = defineProgram({
	id: "watcher",
	args: watcherArgs,
	fill: {reviewer: reviewerProgram},
	init: (): WatcherState => ({child: null, ended: null, stops: 0}),
	update: {
		hatch: (state: WatcherState) => [state, [spawn(watcherArgs.reviewer, {on: {result: "seen"}})]],
		spawned: (state: WatcherState, event: Spawned) => [{...state, child: event.process}, []],
		halt: (state: WatcherState) => [state, state.child === null ? [] : [stop(state.child)]],
		stopped: (state: WatcherState, event: Stopped) => [
			{...state, ended: event.process, stops: state.stops + 1},
			[],
		],
	},
});

/**
 * Wait for the forked delivery, then keep waiting a little after it lands. A second `stopped` would
 * arrive on the same path as the first, so a test that stopped at the first one could not tell one
 * event from two — the trailing settle is what makes the `stops` assertion mean something.
 */
const settle = (ready: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
			yield* Effect.sleep("5 millis");
		}
		yield* Effect.sleep("30 millis");
	});

/** Start the watcher as a root, make it hatch, and answer with its handle and its child's id. */
const watching = Effect.gen(function* () {
	const spawner = yield* SpawnedProcesses;
	const parent = yield* spawner.spawn(ProgramId.make("watcher"), Option.none());
	const handle = Option.getOrThrow(yield* Processes.use((processes) => processes.handle(parent)));
	yield* handle.dispatch({type: "hatch"});
	const child = (handle.getState() as WatcherState).child;
	assert.isNotNull(child);
	return {handle, child: child as ProcessId, read: () => handle.getState() as WatcherState};
});

describe("authoring.defineProgram hearing a child end, through the real kernel", () => {
	it.live("hands the spawner a `stopped` for a child that ended on its own", () =>
		Effect.gen(function* () {
			const {child, read} = yield* watching;

			// Ended from outside the parent: nothing it asked for, and the case that reached nobody
			// before #9227. A crashing child leaves the table by this same finalizer.
			yield* Processes.use((processes) => processes.stop(child));
			yield* settle(() => read().ended !== null);

			assert.strictEqual(read().ended, child);
			assert.strictEqual(read().stops, 1);
		}).pipe(Effect.provide(kernel([watcher, reviewerRow]))),
	);

	it.live("hands it one `stopped`, not two, for a child it stopped itself", () =>
		Effect.gen(function* () {
			const {handle, child, read} = yield* watching;

			yield* handle.dispatch({type: "halt"});
			yield* settle(() => read().ended !== null);

			assert.strictEqual(read().ended, child);
			assert.strictEqual(read().stops, 1);
		}).pipe(Effect.provide(kernel([watcher, reviewerRow]))),
	);
});

/**
 * R12.1's other half (#9294): an effect the *author* named, answered from an authored `update` cell
 * and run by a handler the row was spread with. The type half is `defineProgram`'s `X`; the runtime
 * half is `{...row, handlers: {...row.handlers, run}}`, and this file's claim is that the two meet —
 * the actor dispatches the Cmd to that handler by string and its follow-up Msg lands back in the
 * process's own inbox, on the same `SpawnedProcesses` + `Processes` layer the box boots.
 *
 * The second test is the documented silence: `defineProgram` compiles before any spread exists, so
 * it cannot refuse a named effect with no handler. A row that opts in and forgets the spread is
 * skipped by the actor and keeps running, which is exactly what a hand-assembled row has always
 * done for the same mistake.
 */
type Run = {readonly type: "run"; readonly command: string};
type Ran = {readonly type: "ran"; readonly output: string};

const run = (command: string): Run => ({type: "run", command});

interface RunnerState {
	readonly asked: string | null;
	readonly output: string | null;
}

const runnerInit = (): RunnerState => ({asked: null, output: null});

const runnerUpdate = {
	go: (state: RunnerState): Answer<RunnerState, Run> => [{...state, asked: "echo"}, [run("echo")]],
	ran: (state: RunnerState, event: Ran): Answer<RunnerState, Run> => [
		{...state, output: event.output},
		[],
	],
};

/**
 * `Run` is named only in a cell's answer, which is not a place inference reaches, so an opted-in
 * program states the whole argument list once over an `update` declared beside the call.
 */
const runnerRow = (id: string) =>
	defineProgram<
		RunnerState,
		Record<string, never>,
		typeof runnerUpdate,
		Record<string, never>,
		Run
	>({id, init: runnerInit, update: runnerUpdate});

const compiledRunner = runnerRow("runner");

/** The compiled row, plus the one handler the layer does not write. The spread is the whole seam. */
const runner: AnyProgram = {
	...compiledRunner,
	handlers: {
		...compiledRunner.handlers,
		run: (cmd: Run) => Effect.succeed([{type: "ran", output: `ran:${cmd.command}`} satisfies Ran]),
	},
};

/** The same program with the spread left off: it names `run` and no handler answers it. */
const unhandledRunner: AnyProgram = runnerRow("runner-bare");

const running = (programId: string) =>
	Effect.gen(function* () {
		const spawner = yield* SpawnedProcesses;
		const id = yield* spawner.spawn(ProgramId.make(programId), Option.none());
		const handle = Option.getOrThrow(yield* Processes.use((processes) => processes.handle(id)));
		return {handle, read: () => handle.getState() as RunnerState};
	});

describe("authoring.defineProgram answering an effect of the author's own", () => {
	it("keeps the six kernel effects closed for a program that named none", () => {
		const cell = (state: CounterState): Answer<CounterState> => [
			state,
			[
				// @ts-expect-error a program naming no effect of its own answers the six and nothing
				// else, so a typo is still refused at compile rather than skipped at runtime.
				{type: "emitt", port: "announced", payload: 1},
			],
		];

		expect(cell({count: 1})[0]).toEqual({count: 1});
	});

	it("widens the answer to exactly the effect a program did name", () => {
		expectTypeOf<Answer<RunnerState, Run>[1]>().toEqualTypeOf<ReadonlyArray<ProgramEffect | Run>>();
		expectTypeOf<Answer<RunnerState>[1]>().toEqualTypeOf<ReadonlyArray<ProgramEffect>>();
	});

	it.live("runs the handler the row was spread with and dispatches its follow-up", () =>
		Effect.gen(function* () {
			const {handle, read} = yield* running("runner");

			yield* handle.dispatch({type: "go"});
			yield* settle(() => read().output !== null);

			assert.strictEqual(read().asked, "echo");
			assert.strictEqual(read().output, "ran:echo");
		}).pipe(Effect.provide(kernel([runner]))),
	);

	it.live("skips a named effect no handler answers, and leaves the process running", () =>
		Effect.gen(function* () {
			const {handle, read} = yield* running("runner-bare");

			yield* handle.dispatch({type: "go"});
			yield* settle(() => read().output !== null);
			assert.strictEqual(read().output, null);

			// Skipped, not crashed: the next event still lands on the same live process.
			yield* handle.dispatch({type: "ran", output: "by hand"});
			yield* settle(() => read().output !== null);
			assert.strictEqual(read().output, "by hand");
		}).pipe(Effect.provide(kernel([unhandledRunner]))),
	);
});

/**
 * The inference test above runs at a call site, which is where TypeScript contextually types an
 * object literal. These run at a binding, which is where an author actually keeps the record — the
 * config compiles it, a test drives it — and where nothing typed it before `program` (#8825).
 */
describe("authoring.program types a program held in a binding", () => {
	it("infers each cell's state, its arriving event and its `Answer` return", () => {
		const held = program({
			id: "held",
			ports: {ticks: port.in(Count), review: port.request(Review, Count)},
			init: (): CounterState => ({count: 0}),
			update: {
				ticks: (state, event) => {
					expectTypeOf(state).toEqualTypeOf<CounterState>();
					expectTypeOf(state).not.toBeAny();
					expectTypeOf(event).toEqualTypeOf<ArrivalEvent<"ticks", number>>();
					expectTypeOf(event).not.toBeAny();
					return [{count: state.count + event.payload}, []];
				},
				review: (state, event) => {
					expectTypeOf(event.payload).toEqualTypeOf<{
						readonly pr: number;
						readonly urgent: boolean;
					}>();
					return [state, []];
				},
			},
			title: (state) => `held (${state.count})`,
		});

		// The fields the author wrote read back as written rather than as possibly-`undefined`,
		// which is what the `A` half of the signature buys.
		expect(held.ports.ticks.direction).toBe("in");
		expect(held.title({count: 2})).toBe("held (2)");
		expect(held.update.ticks({count: 1}, {type: "ticks", payload: 2})[0]).toEqual({count: 3});
	});

	it("is the same record `defineProgram` takes, so the author keeps one binding", () => {
		const held = program({
			id: "held-compiled",
			ports: {ticks: port.in(Count)},
			init: (): CounterState => ({count: 0}),
			update: {ticks: (state, event) => [{count: state.count + event.payload}, []]},
		});
		const row = defineProgram(held);
		expect(row.id).toBe("held-compiled");
		expect(Object.keys(row.receive ?? {})).toEqual(["ticks"]);
		expect(row.core.init(null, undefined)).toEqual([{count: 0}, []]);
	});

	it("restores the inference without loosening it: a cell answering no `Answer<S>` is refused", () => {
		const held = program({
			id: "held-wrong-answer",
			ports: {ticks: port.in(Count)},
			init: (): CounterState => ({count: 0}),
			update: {
				// @ts-expect-error a cell answers the next state *and* the effects it asks for, and a
				// bare state is not that tuple — the refusal the hand-written `Answer<S>` used to give.
				ticks: (state) => state,
			},
		});

		expect(held.id).toBe("held-wrong-answer");
	});

	it("restores the inference without loosening it: a field the port does not carry is refused", () => {
		const held = program({
			id: "held-wrong-event",
			ports: {ticks: port.in(Count)},
			init: (): CounterState => ({count: 0}),
			update: {
				// @ts-expect-error `ticks` carries a number, so its arrival has a `payload` and no
				// `urgent` — an inferred event is checked exactly as an annotated one was.
				ticks: (state, event) => [{count: state.count + (event.urgent ? 1 : 0)}, []],
			},
		});

		expect(held.id).toBe("held-wrong-event");
	});

	it("refuses a field the record does not carry, as `defineProgram({...})` refuses one", () => {
		const held = program({
			id: "held-typo",
			ports: {ticks: port.in(Count)},
			init: (): CounterState => ({count: 0}),
			update: {ticks: (state, event) => [{count: state.count + event.payload}, []]},
			// @ts-expect-error `A` is an inference site for the literal itself, so every field the
			// author wrote is a known property of the target and TypeScript's own excess-property
			// check cannot fire. `NoStrayFields` is what replaces it: a key `AuthoredProgram` does
			// not declare is typed `never`, so a misspelled `title` is refused at the field.
			titel: (state: CounterState) => `held (${state.count})`,
		});

		expect(held.id).toBe("held-typo");
	});

	it("types the two answer events the layer owns, so neither cell names its own", () => {
		const held = program({
			id: "held-answers",
			init: (): CounterState => ({count: 0}),
			update: {
				spawned: (state, event) => {
					expectTypeOf(event).toEqualTypeOf<Spawned>();
					expectTypeOf(event).not.toBeAny();
					return [state, [send({process: event.process, port: "prompt"}, event.program)]];
				},
				stopped: (state, event) => {
					expectTypeOf(event).toEqualTypeOf<Stopped>();
					expectTypeOf(event).not.toBeAny();
					return [{count: state.count + 1}, []];
				},
			},
		});

		expect(held.update.stopped({count: 1}, stopped(ProcessId.make("proc-x")))[0]).toEqual({
			count: 2,
		});
	});
});

/**
 * A program with both arriving kinds and a module window, which is the general case #9543 found
 * under the keyboard report: a port arm fails the `Message` constraint exactly as a `key` cell did,
 * so a window over any in-port had the same choice between a typed dispatch and its ports.
 */
const portedWindow = program({
	id: "ported-window",
	ports: {ticks: port.in(Count), review: port.request(Review, Count)},
	init: (): CounterState => ({count: 0}),
	update: {
		ticks: (state, event) => [{count: state.count + event.payload}, []],
		review: (state) => [state, []],
		reset: (state: CounterState) => [{count: 0}, []],
	},
	renderer: {kind: "module", ref: "/src/demo/module-window.tsx"},
});

/** The host that program's window types its dispatch at, exactly as `../demo/module-window.tsx` does. */
type PortedHost = WindowHost<
	CounterState,
	ProgramEvent<(typeof portedWindow)["ports"], (typeof portedWindow)["update"]>
>;

/** Does that host's dispatch still take this event — narrow, rather than widened to `Message`? */
type Dispatches<E> = PortedHost["dispatch"] extends (msg: E) => unknown ? true : false;

const arrivalDispatches: Dispatches<ArrivalEvent<"ticks", number>> = true;
const requestArrivalDispatches: Dispatches<
	RequestArrivalEvent<"review", {readonly pr: number; readonly urgent: boolean}>
> = true;
const ownEventDispatches: Dispatches<{readonly type: "reset"}> = true;
const strangerDispatches: Dispatches<{readonly type: "unheard"}> = false;

describe("authoring.defineProgram window host over a program's ports", () => {
	it("lets a module window type its host at a program with in-ports, plain and request", () => {
		// Each `=` above is the claim, checked by `tsc` over this file
		// (`.patterns/unconditional-test-assertions.md`, "the type-level sibling"). `PortedHost`
		// itself is the claim #9543 turns on: it is TS2344 while either arrival arm is an
		// interface, because `WindowHost`'s Msg parameter is constrained to the kernel's `Message`.
		expect([
			arrivalDispatches,
			requestArrivalDispatches,
			ownEventDispatches,
			strangerDispatches,
		]).toEqual([true, true, true, false]);
	});
});
