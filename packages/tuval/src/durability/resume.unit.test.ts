/**
 * The seam both spawners take after bringing a process back: the row's own `resume`, dispatched.
 *
 * The two callers are proven where they run — `launch` by the restore proofs under
 * `src/ai-agent/restore/` and `src/pi/restore/`, `durability/restore.ts` by
 * `restore-services.unit.test.ts`. What is proven here is the step itself, including the case with
 * no test above it: a row that declares no `resume` is sent nothing at all.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {dispatchResume} from "./resume.ts";
import {memoryStores} from "./stores.ts";

type State = {readonly woke: number; readonly saved: boolean};
type Msg = {readonly type: "wake"};

const core = defineMachine<State, Msg, never, never, unknown>({
	init: (loaded) => [loaded ?? {woke: 0, saved: true}, []],
	update: {wake: (state) => [{...state, woke: state.woke + 1}, []]},
});

const row = (id: string, resume?: (state: State) => ReadonlyArray<Msg>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports: {},
		handlers: {},
		...(resume === undefined ? {} : {resume}),
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, never, never, unknown, never, never>;

const WAKING = "waking";
const SILENT = "silent";

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(
		Registry.layer([row(WAKING, (state) => (state.saved ? [{type: "wake"}] : [])), row(SILENT)]),
	),
);

const spawn = (program: string, id: string) =>
	Effect.flatMap(Processes, (processes) =>
		processes.spawn(ProgramId.make(program), {
			id: ProcessId.make(id),
			services: Context.empty(),
		}),
	);

describe("the resume a spawner dispatches into a restored process", () => {
	it.effect("sends the row's own Msgs, folded into the state the caller then reads", () =>
		Effect.gen(function* () {
			const handle = yield* spawn(WAKING, "waking-one");
			const registry = yield* Registry;
			yield* dispatchResume(yield* registry.resolve(ProgramId.make(WAKING)), handle);
			assert.deepStrictEqual(handle.getState(), {woke: 1, saved: true});
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);

	it.effect("sends nothing to a row that declares no resume", () =>
		Effect.gen(function* () {
			const handle = yield* spawn(SILENT, "silent-one");
			const registry = yield* Registry;
			yield* dispatchResume(yield* registry.resolve(ProgramId.make(SILENT)), handle);
			assert.deepStrictEqual(handle.getState(), {woke: 0, saved: true});
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);

	it.effect("sends nothing when the row's own answer is empty", () =>
		Effect.gen(function* () {
			const handle = yield* spawn(WAKING, "waking-two");
			const registry = yield* Registry;
			const waking = yield* registry.resolve(ProgramId.make(WAKING));
			assert.deepStrictEqual(waking.resume?.({woke: 0, saved: false}), []);
			yield* dispatchResume(waking, handle);
			assert.deepStrictEqual(handle.getState(), {woke: 1, saved: true});
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);
});
