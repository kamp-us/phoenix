/**
 * The tea 0.18 engine behaviours a process relies on, pinned where Tuval meets them: a process run
 * by `Processes` on `run` from `@demlik/tea/effect`. These replace the coverage the in-tree host's
 * own tests gave before that host was retired.
 */

import {defineMachine, NoCellError} from "@demlik/tea";
import {drive} from "@demlik/tea/testing/effect";
import {assert, describe, it} from "@effect/vitest";
import {Context, Deferred, Effect, Fiber, Layer, Stream} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {dispatchResume} from "../durability/resume.ts";
import {memoryStores} from "../durability/stores.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {HandlerFailed} from "./errors.ts";
import {Processes} from "./Processes.ts";
import {ProcessTable} from "./ProcessTable.ts";
import {type ProcessChange, ProcessId} from "./process.ts";

type State = {readonly seen: ReadonlyArray<string>};
type Msg =
	| {readonly type: "fan"}
	| {readonly type: "note"; readonly word: string}
	| {readonly type: "boom"}
	| {readonly type: "hang"}
	| {readonly type: "wake"};
type Work = {readonly type: "fan"} | {readonly type: "boom"} | {readonly type: "hang"};

const WORDS = ["one", "two", "three"] as const;

const saw = (state: State, word: string): State => ({seen: [...state.seen, word]});

/**
 * One machine for every behaviour: `fan` answers with several Msgs, `boom` with a failing handler,
 * `hang` with a handler that never settles, and `wake` is the row's resume. A Msg outside these five
 * has no cell.
 */
const core = defineMachine<State, Msg, Work, never, unknown>({
	init: (loaded) => [loaded ?? {seen: []}, []],
	update: {
		fan: (state) => [saw(state, "fan"), [{type: "fan"}]],
		note: (state, msg) => [saw(state, msg.word), []],
		boom: (state) => [saw(state, "boom"), [{type: "boom"}]],
		hang: (state) => [saw(state, "hang"), [{type: "hang"}]],
		wake: (state) => [saw(state, "wake"), []],
	},
});

interface Probe {
	readonly started: Deferred.Deferred<void>;
	readonly finalized: string[];
}

/** One cell map for both the row and `drive`, so the two run the same handlers. */
const cells = (probe: Probe) => ({
	fan: () => Effect.succeed(WORDS.map((word): Msg => ({type: "note", word}))),
	boom: () => Effect.fail("boom refused"),
	hang: () =>
		Deferred.succeed(probe.started, undefined).pipe(
			Effect.andThen(Effect.never),
			Effect.ensuring(Effect.sync(() => void probe.finalized.push("hang:finalized"))),
		),
});

const LEDGER = ProgramId.make("ledger");

const ledger = (probe: Probe): AnyProgram =>
	({
		id: LEDGER,
		core,
		ports: {},
		handlers: cells(probe),
		resume: (state) => (state.seen.length > 0 ? [{type: "wake"}] : []),
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "ledger",
			version: "1.0.0",
			digest: "sha256:ledger",
		},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Work, never, unknown, string, never>;

const withKernel = <A, E>(
	body: (probe: Probe) => Effect.Effect<A, E, Processes | ProcessTable | Registry>,
) =>
	Effect.gen(function* () {
		const probe: Probe = {started: yield* Deferred.make<void>(), finalized: []};
		return yield* body(probe).pipe(
			Effect.provide(
				Processes.layer.pipe(
					Layer.provideMerge(Registry.layer([ledger(probe)])),
					Layer.provide(Checkpoints.layer(memoryStores())),
				),
			),
		);
	});

const spawn = (id?: string) =>
	Effect.flatMap(Processes, (processes) =>
		processes.spawn(LEDGER, {
			...(id === undefined ? {} : {id: ProcessId.make(id)}),
			services: Context.empty(),
		}),
	);

const seen = (state: unknown) => (state as State).seen;

/** Subscribe now and collect the next `count` changes; the join is the wait. */
const collect = (changes: Stream.Stream<ProcessChange>, count: number) =>
	Effect.forkChild(Stream.runCollect(Stream.take(changes, count)), {startImmediately: true});

describe("a process on tea's Effect engine", () => {
	it.effect("refuses a Msg with no cell and keeps running (demlik #310)", () =>
		withKernel(() =>
			Effect.gen(function* () {
				const table = yield* ProcessTable;
				const handle = yield* spawn();

				// tea refuses on the dispatch's defect channel: `NoCellError` is not a `DispatchError`.
				const refused = yield* handle
					.dispatch({type: "ghost"})
					.pipe(Effect.catchDefect(Effect.succeed));

				assert.instanceOf(refused, NoCellError);
				assert.strictEqual((refused as NoCellError).msgType, "ghost");
				assert.deepStrictEqual(seen(handle.getState()), []);
				yield* handle.dispatch({type: "note", word: "after"});
				assert.deepStrictEqual(seen(handle.getState()), ["after"]);
				const row = yield* table.get(handle.id);
				assert.strictEqual(row.stateSummary().lifecycle, "running");
			}),
		),
	);

	it.effect("publishes the commit to the view stream when a Cmd handler fails (demlik #311)", () =>
		withKernel(() =>
			Effect.gen(function* () {
				const table = yield* ProcessTable;
				const handle = yield* spawn();
				const changes = yield* collect(table.changes, 1);

				const failed = yield* Effect.flip(handle.dispatch({type: "boom"}));

				assert.instanceOf(failed, HandlerFailed);
				assert.strictEqual(failed.cmdType, "boom");
				const [change] = yield* Fiber.join(changes);
				assert.strictEqual(change?.kind, "state-changed");
				assert.strictEqual(change?.row.id, handle.id);
				assert.deepStrictEqual(seen(change?.row.stateSummary().state), ["boom"]);
				assert.strictEqual(change?.row.stateSummary().revision, 1);
			}),
		),
	);

	it.effect("dispatches a handler's several Msgs in order (demlik #324)", () =>
		withKernel((probe) =>
			Effect.gen(function* () {
				const handle = yield* spawn();

				yield* handle.dispatch({type: "fan"});

				assert.deepStrictEqual(seen(handle.getState()), ["fan", ...WORDS]);
				const driven = yield* drive(core, {seen: []}, {type: "fan"}, cells(probe));
				assert.deepStrictEqual(driven.state.seen, ["fan", ...WORDS]);
			}),
		),
	);

	it.effect("interrupts in-flight handlers when its Scope closes, then refuses as Stopped", () =>
		withKernel((probe) =>
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* spawn();
				const dispatching = yield* Effect.forkChild(handle.dispatch({type: "hang"}));
				yield* Deferred.await(probe.started);
				assert.deepStrictEqual(probe.finalized, []);

				yield* processes.stop(handle.id);

				assert.deepStrictEqual(probe.finalized, ["hang:finalized"]);
				yield* Fiber.join(dispatching);
				const refused = yield* Effect.flip(handle.dispatch({type: "note", word: "late"}));
				assert.strictEqual(refused._tag, "Stopped");
				assert.deepStrictEqual(seen(handle.getState()), ["hang"]);
			}),
		),
	);

	it.effect("folds a resume Msg dispatched after a restored boot (demlik #318)", () =>
		withKernel(() =>
			Effect.gen(function* () {
				const processes = yield* Processes;
				const registry = yield* Registry;
				const first = yield* spawn("restored");
				yield* first.dispatch({type: "note", word: "before"});
				yield* processes.stop(first.id);

				const restored = yield* spawn("restored");
				assert.deepStrictEqual(seen(restored.getState()), ["before"]);
				yield* dispatchResume(yield* registry.resolve(LEDGER), restored);

				assert.deepStrictEqual(seen(restored.getState()), ["before", "wake"]);
			}),
		),
	);
});
