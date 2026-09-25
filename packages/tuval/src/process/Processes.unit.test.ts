import {type Cmd, defineMachine, type Sub} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option, Scope, Stream} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {snapshotAt, watchingStores} from "../durability/fixtures.ts";
import {type CheckpointStores, memoryStores} from "../durability/stores.ts";
import {ProgramNotFound} from "../registry/errors.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {ForgetRefused, ProcessIsPlanned, ProcessNotFound} from "./errors.ts";
import {PlannedProcesses} from "./PlannedProcesses.ts";
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

type Run = Sub<"run", {readonly runId: string}>;

/** A counter whose dep-keyed Sub logs its open and close, and whose `notify` Cmd follows up with `acked`. */
const counterProgram = (probe: Probe): AnyProgram =>
	({
		id: ProgramId.make("counter"),
		core: defineMachine<State, Msg, Notify, Run, unknown>({
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
					type: "run",
					deps: (state) => (state.type === "running" ? {runId: state.runId} : null),
				},
			],
		}),
		ports,
		handlers: {
			notify: (cmd: Notify) =>
				Effect.sync((): ReadonlyArray<Msg> => {
					probe.log.push(`notify:${cmd.count}`);
					return [{type: "acked"}];
				}),
		},
		subs: {
			run: (sub: Run) =>
				Stream.never.pipe(
					Stream.onStart(Effect.sync(() => void probe.log.push(`sub:start:${sub.deps.runId}`))),
					Stream.ensuring(Effect.sync(() => void probe.log.push(`sub:stop:${sub.deps.runId}`))),
				),
		},
		capabilities: [],
		identity: identity("counter"),
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Notify, Run, unknown, never, never>;

type Switch = {readonly type: "off"} | {readonly type: "on"};
type Toggle = {readonly type: "toggle"};
type Ticker = Sub<"ticker", true>;

/** A Sub whose deps hold no data beyond on-or-off, run by the row's runner of its type. */
const tickerProgram = (log: string[]): AnyProgram =>
	({
		id: ProgramId.make("ticker"),
		core: defineMachine<Switch, Toggle, Cmd<never>, Ticker, unknown>({
			init: () => [{type: "off"}, []],
			update: {toggle: (state) => [{type: state.type === "off" ? "on" : "off"}, []]},
			subs: [{type: "ticker", deps: (state) => (state.type === "on" ? true : null)}],
		}),
		ports: {},
		handlers: {},
		subs: {
			ticker: () =>
				Stream.never.pipe(
					Stream.onStart(Effect.sync(() => void log.push("ticker:open"))),
					Stream.ensuring(Effect.sync(() => void log.push("ticker:close"))),
				),
		},
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
				const handle = yield* processes.spawn(counter, {services: Context.empty()});
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
				const a = yield* processes.spawn(counter, {services: Context.empty()});
				const b = yield* processes.spawn(counter, {services: Context.empty()});
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
				const root = yield* processes.spawn(counter, {services: Context.empty()});
				const child = yield* processes.spawn(counter, {parent: root.id, services: Context.empty()});
				assert.deepStrictEqual(child.parentId, Option.some(root.id));
				assert.deepStrictEqual(root.parentId, Option.none());
				assert.deepStrictEqual((yield* table.get(child.id)).parentId, Option.some(root.id));

				const orphan = ProcessId.make("nobody");
				const refused = yield* processes
					.spawn(counter, {parent: orphan, services: Context.empty()})
					.pipe(Effect.flip);
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
					const handle = yield* processes.spawn(counter, {services: Context.empty()});
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
				const root = yield* processes.spawn(counter, {services: Context.empty()});
				const child = yield* processes.spawn(counter, {parent: root.id, services: Context.empty()});
				const grandchild = yield* processes.spawn(counter, {
					parent: child.id,
					services: Context.empty(),
				});
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
				const handle = yield* processes.spawn(counter, {services: Context.empty()});
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
				const refused = yield* processes
					.spawn(missing, {services: Context.empty()})
					.pipe(Effect.flip);
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
				const root = yield* processes.spawn(counter, {services: Context.empty()});
				const child = yield* processes.spawn(counter, {parent: root.id, services: Context.empty()});
				yield* child.dispatch({type: "start", runId: "c"});

				const row = yield* table.get(child.id);
				assert.strictEqual(row.id, child.id);
				assert.strictEqual(row.programId, counter);
				assert.deepStrictEqual(row.parentId, Option.some(root.id));
				assert.strictEqual(row.ports, ports);
				assert.deepStrictEqual(row.stateSummary(), {
					lifecycle: "running",
					revision: 1,
					state: {type: "running", runId: "c", count: 0, acks: 0},
				});
				yield* child.dispatch({type: "tick"});
				assert.strictEqual((row.stateSummary().state as State).count, 1);
				assert.strictEqual(row.stateSummary().revision, 3);
			}),
		);
	});

	/**
	 * Removal (#9446): the durable forget, then the Scope. The order is the whole guarantee, so it is
	 * asserted as an order — the store's writes and the process's own Sub disposal land in one log,
	 * and the Sub closes with the Scope.
	 */
	describe("remove", () => {
		const withStores = <A, E>(
			rows: ReadonlyArray<AnyProgram>,
			stores: CheckpointStores,
			body: Effect.Effect<A, E, Processes | ProcessTable | Checkpoints | PlannedProcesses>,
		) =>
			body.pipe(
				Effect.provide(
					Processes.layer.pipe(
						Layer.provideMerge(Checkpoints.layer(stores)),
						Layer.provideMerge(Registry.layer(rows)),
					),
				),
			);

		it.effect("writes the durable forget before it closes the process Scope", () => {
			const probe: Probe = {log: [], reduced: 0};
			const watched = watchingStores(probe.log);
			return withStores(
				[counterProgram(probe)],
				watched.stores,
				Effect.gen(function* () {
					const processes = yield* Processes;
					const checkpoints = yield* Checkpoints;
					const table = yield* ProcessTable;
					const handle = yield* processes.spawn(counter, {services: Context.empty()});
					yield* handle.dispatch({type: "start", runId: "a"});
					probe.log.length = 0;

					yield* processes.remove(handle.id);

					assert.deepStrictEqual(probe.log, [
						`snapshot:drop:${handle.id}`,
						"manifest:save",
						"sub:stop:a",
					]);
					assert.deepStrictEqual(yield* checkpoints.list, []);
					assert.deepStrictEqual(yield* table.list, []);
					assert.isNull(yield* snapshotAt(watched.stores, handle.id));
				}),
			);
		});

		it.effect(
			"leaves a process whose durable write failed running, dispatchable and listed",
			() => {
				const probe: Probe = {log: [], reduced: 0};
				const watched = watchingStores(probe.log);
				return withStores(
					[counterProgram(probe)],
					watched.stores,
					Effect.gen(function* () {
						const processes = yield* Processes;
						const checkpoints = yield* Checkpoints;
						const table = yield* ProcessTable;
						const handle = yield* processes.spawn(counter, {services: Context.empty()});
						yield* handle.dispatch({type: "start", runId: "a"});
						watched.refuseManifestSave = true;

						const refused = yield* Effect.flip(processes.remove(handle.id));

						assert.instanceOf(refused, ForgetRefused);
						assert.strictEqual(refused.id, handle.id);
						assert.strictEqual(
							refused.message,
							`process "${handle.id}" was not removed: its durable forget failed, so the process is still running and still in the manifest`,
						);
						watched.refuseManifestSave = false;
						assert.deepStrictEqual(
							(yield* table.list).map((row) => row.id),
							[handle.id],
						);
						assert.deepStrictEqual(
							(yield* checkpoints.list).map((entry) => entry.id),
							[handle.id as string],
						);
						yield* handle.dispatch({type: "tick"});
						assert.strictEqual((handle.getState() as State).count, 1);
						assert.notInclude(probe.log, "sub:stop:a");
					}),
				);
			},
		);

		it.effect("refuses a graph-declared process, naming the config as the way to remove it", () => {
			const probe: Probe = {log: [], reduced: 0};
			const watched = watchingStores(probe.log);
			return withStores(
				[counterProgram(probe)],
				watched.stores,
				Effect.gen(function* () {
					const processes = yield* Processes;
					const checkpoints = yield* Checkpoints;
					const table = yield* ProcessTable;
					const planned = yield* PlannedProcesses;
					const id = ProcessId.make("shell");
					const handle = yield* processes.spawn(counter, {id, services: Context.empty()});
					yield* planned.declare([id]);

					const refused = yield* Effect.flip(processes.remove(handle.id));

					assert.instanceOf(refused, ProcessIsPlanned);
					assert.strictEqual(
						refused.message,
						'process "shell" is declared by the config graph, so boot would start it again; edit the config to remove it',
					);
					assert.deepStrictEqual(
						(yield* table.list).map((row) => row.id),
						[id],
					);
					assert.deepStrictEqual(
						(yield* checkpoints.list).map((entry) => entry.id),
						[id as string],
					);
				}),
			);
		});

		it.effect("is ProcessNotFound for an id no live process carries, and forgets nothing", () => {
			const probe: Probe = {log: [], reduced: 0};
			const watched = watchingStores(probe.log);
			return withStores(
				[counterProgram(probe)],
				watched.stores,
				Effect.gen(function* () {
					const processes = yield* Processes;
					const checkpoints = yield* Checkpoints;
					const handle = yield* processes.spawn(counter, {services: Context.empty()});

					const refused = yield* Effect.flip(processes.remove(ProcessId.make("nobody")));

					assert.instanceOf(refused, ProcessNotFound);
					assert.deepStrictEqual(
						(yield* checkpoints.list).map((entry) => entry.id),
						[handle.id as string],
					);
				}),
			);
		});

		it.effect("stop is unchanged: the manifest row and the snapshot both survive it", () => {
			const probe: Probe = {log: [], reduced: 0};
			const watched = watchingStores(probe.log);
			return withStores(
				[counterProgram(probe)],
				watched.stores,
				Effect.gen(function* () {
					const processes = yield* Processes;
					const checkpoints = yield* Checkpoints;
					const handle = yield* processes.spawn(counter, {services: Context.empty()});
					yield* handle.dispatch({type: "start", runId: "a"});
					yield* handle.dispatch({type: "tick"});

					yield* processes.stop(handle.id);

					assert.include(probe.log, "sub:stop:a");
					assert.deepStrictEqual(
						(yield* checkpoints.list).map((entry) => entry.id),
						[handle.id as string],
					);
					assert.isNotNull(yield* snapshotAt(watched.stores, handle.id));
				}),
			);
		});
	});

	it.effect("a row's Sub runner opens and closes its Sub through the process scope", () => {
		const log: string[] = [];
		return withKernel(
			[tickerProgram(log)],
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* processes.spawn(ProgramId.make("ticker"), {
					services: Context.empty(),
				});
				yield* handle.dispatch({type: "toggle"});
				assert.deepStrictEqual(log, ["ticker:open"]);
				yield* handle.dispatch({type: "toggle"});
				assert.deepStrictEqual(log, ["ticker:open", "ticker:close"]);
				yield* handle.dispatch({type: "toggle"});
				yield* processes.stop(handle.id);
				assert.deepStrictEqual(log, ["ticker:open", "ticker:close", "ticker:open", "ticker:close"]);
			}),
		);
	});
});
