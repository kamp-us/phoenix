import {type Cmd, defineMachine, type Sub, subId} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Scope} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {ProgramNotFound} from "../registry/errors.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {ProcessNotFound} from "./errors.ts";
import {Processes} from "./Processes.ts";
import {ProcessTable} from "./ProcessTable.ts";
import {ProcessId} from "./process.ts";

type State =
	| {readonly type: "idle"; readonly count: number}
	| {
			readonly type: "running";
			readonly runId: string;
			readonly count: number;
			readonly acks: number;
	  };
type Msg =
	| {readonly type: "start"; readonly runId: string}
	| {readonly type: "tick"}
	| {readonly type: "acked"};
type Notify = {readonly type: "notify"; readonly count: number};

interface Probe {
	readonly log: string[];
	reduced: number;
}

const ports = {
	ticks: {
		kind: "tick/v1",
		direction: "out",
		accepts: (p: unknown): p is number => typeof p === "number",
	},
} as const;

const identity = (program: string) => ({
	package: "@kampus/tuval",
	program,
	version: "1.0.0",
	digest: `sha256:${program}`,
});

/** A counter whose dep-keyed Sub logs its open and close, and whose `notify` Cmd follows up with `acked`. */
const counterProgram = (probe: Probe): AnyProgram =>
	({
		id: ProgramId.make("counter"),
		core: defineMachine<State, Msg, Notify, never, unknown>({
			init: (loaded) => [loaded ?? {type: "idle", count: 0}, []],
			update: {
				start: (state, msg) => [
					{type: "running", runId: msg.runId, count: state.count, acks: 0},
					[],
				],
				tick: (state) => {
					probe.reduced++;
					return state.type === "running"
						? [{...state, count: state.count + 1}, [{type: "notify", count: state.count + 1}]]
						: [state, []];
				},
				acked: (state) =>
					state.type === "running" ? [{...state, acks: state.acks + 1}, []] : [state, []],
			},
			subs: [
				{
					deps: (state) => (state.type === "running" ? {runId: state.runId} : null),
					source: (state) => {
						const runId = state.type === "running" ? state.runId : "?";
						probe.log.push(`sub:start:${runId}`);
						return () => {
							probe.log.push(`sub:stop:${runId}`);
						};
					},
				},
			],
			// Demlik's `Machine` demands a Promise `interpret` beside the row's `handlers`; the host never reads it (#7576).
			interpret: {notify: () => Promise.resolve()},
		}),
		ports,
		handlers: {
			notify: (cmd: Notify) =>
				Effect.sync((): ReadonlyArray<Msg> => {
					probe.log.push(`notify:${cmd.count}`);
					return [{type: "acked"}];
				}),
		},
		capabilities: [],
		identity: identity("counter"),
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Notify, never, unknown, never, never>;

type Switch = {readonly type: "off"} | {readonly type: "on"};
type Toggle = {readonly type: "toggle"};
type Ticker = Sub<"ticker">;

/** A machine on Demlik's manual-Sub map, so the `subscribe` disposer bridge is exercised end to end. */
const tickerProgram = (log: string[]): AnyProgram =>
	({
		id: ProgramId.make("ticker"),
		core: defineMachine<Switch, Toggle, Cmd<never>, Ticker, unknown>({
			init: () => [{type: "off"}, []],
			update: {toggle: (state) => [{type: state.type === "off" ? "on" : "off"}, []]},
			subscriptions: (state) =>
				state.type === "on" ? [{id: subId("ticker"), type: "ticker"}] : [],
			subscribe: {
				ticker: () => {
					log.push("ticker:open");
					return () => {
						log.push("ticker:close");
					};
				},
			},
		}),
		ports: {},
		handlers: {},
		capabilities: [],
		identity: identity("ticker"),
		placement: {host: "local"},
	}) satisfies Program<Switch, Toggle, Cmd<never>, Ticker, unknown, never, never>;

const counter = ProgramId.make("counter");

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable>,
) =>
	body.pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([Registry.layer(rows), Checkpoints.layer(memoryStores())]),
			),
		),
	);

describe("Processes", () => {
	it.effect("spawn returns a handle with a stable id and records the row in ProcessTable", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const handle = yield* processes.spawn(counter);
				const again = yield* table.get(handle.id);
				const listed = yield* table.list;
				assert.strictEqual(again.id, handle.id);
				assert.strictEqual(again.programId, counter);
				assert.deepStrictEqual(
					listed.map((row) => row.id),
					[handle.id],
				);
				assert.isTrue(Option.isNone(handle.parentId));
			}),
		);
	});

	it.effect("two spawns of one program are isolated: distinct ids, no shared state", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const a = yield* processes.spawn(counter);
				const b = yield* processes.spawn(counter);
				assert.notStrictEqual(a.id, b.id);

				yield* a.dispatch({type: "start", runId: "a"});
				yield* a.dispatch({type: "tick"});
				yield* a.dispatch({type: "tick"});
				yield* b.dispatch({type: "start", runId: "b"});

				assert.deepStrictEqual(a.getState(), {type: "running", runId: "a", count: 2, acks: 2});
				assert.deepStrictEqual(b.getState(), {type: "running", runId: "b", count: 0, acks: 0});
				assert.deepStrictEqual(probe.log, ["sub:start:a", "notify:1", "notify:2", "sub:start:b"]);
				assert.strictEqual((yield* table.list).length, 2);
			}),
		);
	});

	it.effect("a spawn with a parent records the link; a root spawn records none", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const root = yield* processes.spawn(counter);
				const child = yield* processes.spawn(counter, {parent: root.id});
				assert.deepStrictEqual(child.parentId, Option.some(root.id));
				assert.deepStrictEqual(root.parentId, Option.none());
				assert.deepStrictEqual((yield* table.get(child.id)).parentId, Option.some(root.id));

				const orphan = ProcessId.make("nobody");
				const refused = yield* processes.spawn(counter, {parent: orphan}).pipe(Effect.flip);
				assert.instanceOf(refused, ProcessNotFound);
				assert.strictEqual(refused.id, orphan);
			}),
		);
	});

	it.effect(
		"stop runs the Demlik disposer and the Effect finalizer once each and drops the row",
		() => {
			const probe: Probe = {log: [], reduced: 0};
			return withKernel(
				[counterProgram(probe)],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const table = yield* ProcessTable;
					const handle = yield* processes.spawn(counter);
					let finalized = 0;
					yield* Scope.addFinalizer(
						handle.scope,
						Effect.sync(() => {
							finalized++;
						}),
					);
					yield* handle.dispatch({type: "start", runId: "r1"});
					assert.deepStrictEqual(probe.log, ["sub:start:r1"]);

					yield* processes.stop(handle.id);
					assert.deepStrictEqual(probe.log, ["sub:start:r1", "sub:stop:r1"]);
					assert.strictEqual(finalized, 1);
					assert.deepStrictEqual(yield* table.list, []);

					const again = yield* processes.stop(handle.id).pipe(Effect.flip);
					assert.instanceOf(again, ProcessNotFound);
					yield* handle.stop;
					assert.deepStrictEqual(probe.log, ["sub:start:r1", "sub:stop:r1"]);
					assert.strictEqual(finalized, 1);
				}),
			);
		},
	);

	it.effect("stopping a parent stops every descendant of a two-level tree", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const root = yield* processes.spawn(counter);
				const child = yield* processes.spawn(counter, {parent: root.id});
				const grandchild = yield* processes.spawn(counter, {parent: child.id});
				yield* root.dispatch({type: "start", runId: "root"});
				yield* child.dispatch({type: "start", runId: "child"});
				yield* grandchild.dispatch({type: "start", runId: "grandchild"});
				assert.strictEqual((yield* table.list).length, 3);

				yield* processes.stop(root.id);

				assert.deepStrictEqual(yield* table.list, []);
				assert.deepStrictEqual(probe.log.filter((line) => line.startsWith("sub:stop")).sort(), [
					"sub:stop:child",
					"sub:stop:grandchild",
					"sub:stop:root",
				]);
				const refused = yield* grandchild.dispatch({type: "tick"}).pipe(Effect.flip);
				assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
			}),
		);
	});

	it.effect("a dispatch after stop is refused loudly and never reaches the machine", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* processes.spawn(counter);
				yield* handle.dispatch({type: "start", runId: "r1"});
				yield* handle.dispatch({type: "tick"});
				assert.strictEqual(probe.reduced, 1);

				yield* handle.stop;
				const refused = yield* handle.dispatch({type: "tick"}).pipe(Effect.flip);
				assert.strictEqual(refused._tag, "tuval/host/ActorStoppedError");
				assert.strictEqual(probe.reduced, 1);
				assert.deepStrictEqual(handle.getState(), {
					type: "running",
					runId: "r1",
					count: 1,
					acks: 1,
				});
			}),
		);
	});

	it.effect("spawning an unregistered program id fails with a typed error naming the id", () =>
		withKernel(
			[],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const missing = ProgramId.make("ghost");
				const refused = yield* processes.spawn(missing).pipe(Effect.flip);
				assert.instanceOf(refused, ProgramNotFound);
				assert.strictEqual(refused.id, missing);
			}),
		),
	);

	it.effect("ProcessTable reports id, program, parent, ports and a live state summary", () => {
		const probe: Probe = {log: [], reduced: 0};
		return withKernel(
			[counterProgram(probe)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const root = yield* processes.spawn(counter);
				const child = yield* processes.spawn(counter, {parent: root.id});
				yield* child.dispatch({type: "start", runId: "c"});

				const row = yield* table.get(child.id);
				assert.strictEqual(row.id, child.id);
				assert.strictEqual(row.programId, counter);
				assert.deepStrictEqual(row.parentId, Option.some(root.id));
				assert.strictEqual(row.ports, ports);
				assert.deepStrictEqual(row.stateSummary(), {
					lifecycle: "running",
					state: {type: "running", runId: "c", count: 0, acks: 0},
				});
				yield* child.dispatch({type: "tick"});
				assert.strictEqual((row.stateSummary().state as State).count, 1);
			}),
		);
	});

	it.effect(
		"a program on Demlik's manual-Sub map opens and closes its Sub through the process scope",
		() => {
			const log: string[] = [];
			return withKernel(
				[tickerProgram(log)],
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(ProgramId.make("ticker"));
					yield* handle.dispatch({type: "toggle"});
					assert.deepStrictEqual(log, ["ticker:open"]);
					yield* handle.dispatch({type: "toggle"});
					assert.deepStrictEqual(log, ["ticker:open", "ticker:close"]);
					yield* handle.dispatch({type: "toggle"});
					yield* processes.stop(handle.id);
					assert.deepStrictEqual(log, [
						"ticker:open",
						"ticker:close",
						"ticker:open",
						"ticker:close",
					]);
				}),
			);
		},
	);
});
