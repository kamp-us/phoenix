import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema} from "effect";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {CheckpointHeld, SnapshotMalformed, SnapshotRefused} from "./errors.ts";
import {restore} from "./restore.ts";
import {parseSnapshot} from "./snapshot.ts";
import {type CheckpointStores, fileStores, memoryStores} from "./stores.ts";

type State = {readonly count: number; readonly acks: number};
type Msg = {readonly type: "tick"} | {readonly type: "acked"};
type Notify = {readonly type: "notify"; readonly count: number};

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

interface Probe {
	readonly log: string[];
	/** The process whose snapshot `notify` reads back; `seenAtNotify` is its count at each run. */
	watched: ProcessId;
	readonly seenAtNotify: Array<number | null>;
}

const probeOf = (): Probe => ({log: [], watched: ProcessId.make("unset"), seenAtNotify: []});

const counter = ProgramId.make("counter");

/** A counter whose `notify` handler reads the process's snapshot back before it acks. */
const counterProgram = (probe: Probe, stores: CheckpointStores, version = "1.0.0"): AnyProgram =>
	({
		id: counter,
		core: defineMachine<State, Msg, Notify, never, unknown>({
			init: (loaded) => [loaded ?? {count: 0, acks: 0}, []],
			update: {
				tick: (state) => [
					{...state, count: state.count + 1},
					[{type: "notify", count: state.count + 1}],
				],
				acked: (state) => [{...state, acks: state.acks + 1}, []],
			},
			interpret: {notify: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {
			notify: (cmd: Notify) =>
				Effect.gen(function* () {
					const raw = yield* io(() => stores.snapshot(probe.watched).load());
					const saved = parseSnapshot(raw)?.state as State | undefined;
					probe.seenAtNotify.push(saved?.count ?? null);
					probe.log.push(`notify:${cmd.count}`);
					return [{type: "acked"}] as ReadonlyArray<Msg>;
				}),
		},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "counter", version, digest: "sha256:counter"},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Notify, never, unknown, TestIo, never>;

const kernel = (rows: ReadonlyArray<AnyProgram>, stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provide(Registry.layer(rows)),
	);

describe("durability", () => {
	it.effect("a process saves its snapshot before its effects run", () => {
		const stores = memoryStores();
		const probe = probeOf();
		return Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(counter);
			probe.watched = handle.id;
			yield* handle.dispatch({type: "tick"});
			yield* handle.dispatch({type: "tick"});
			assert.deepStrictEqual(probe.log, ["notify:1", "notify:2"]);
			assert.deepStrictEqual(probe.seenAtNotify, [1, 2]);
		}).pipe(Effect.provide(kernel([counterProgram(probe, stores)], stores)));
	});

	it.effect(
		"open is an acquire/release under the process scope: held while live, free on stop",
		() => {
			const stores = memoryStores();
			const probe = probeOf();
			return Effect.gen(function* () {
				const processes = yield* Processes;
				const id = ProcessId.make("fixed");
				const first = yield* processes.spawn(counter, {id});
				const held = yield* processes.spawn(counter, {id}).pipe(Effect.flip);
				assert.instanceOf(held, CheckpointHeld);
				assert.strictEqual(held.processId, id);

				yield* first.stop;
				const again = yield* processes.spawn(counter, {id});
				assert.strictEqual(again.id, id);
			}).pipe(Effect.provide(kernel([counterProgram(probe, stores)], stores)));
		},
	);

	it.effect(
		"a clean stop and reload restores each process at its state with id and parent intact, replays no effect, and one new input yields exactly one",
		() => {
			const stores = memoryStores();
			const probe = probeOf();
			const rows = [counterProgram(probe, stores)];
			return Effect.gen(function* () {
				const before = yield* Effect.gen(function* () {
					const processes = yield* Processes;
					const root = yield* processes.spawn(counter);
					const child = yield* processes.spawn(counter, {parent: root.id});
					yield* root.dispatch({type: "tick"});
					yield* root.dispatch({type: "tick"});
					yield* child.dispatch({type: "tick"});
					return {root: root.id, child: child.id};
				}).pipe(Effect.provide(kernel(rows, stores)));
				assert.deepStrictEqual(probe.log, ["notify:1", "notify:2", "notify:1"]);

				yield* Effect.gen(function* () {
					const table = yield* ProcessTable;
					const restored = yield* restore;
					assert.deepStrictEqual(
						restored.map((handle) => handle.id),
						[before.root, before.child],
					);
					const [root, child] = restored;
					assert.strictEqual(root!.programId, counter);
					assert.deepStrictEqual(root!.parentId, Option.none());
					assert.deepStrictEqual(child!.parentId, Option.some(before.root));
					assert.deepStrictEqual(root!.getState(), {count: 2, acks: 2});
					assert.deepStrictEqual(child!.getState(), {count: 1, acks: 1});
					assert.deepStrictEqual(
						(yield* table.list).map((row) => row.id),
						[before.root, before.child],
					);
					assert.deepStrictEqual(probe.log, ["notify:1", "notify:2", "notify:1"]);

					yield* root!.dispatch({type: "tick"});
					assert.deepStrictEqual(probe.log, ["notify:1", "notify:2", "notify:1", "notify:3"]);
					assert.deepStrictEqual(root!.getState(), {count: 3, acks: 3});
				}).pipe(Effect.provide(kernel(rows, stores)));
			});
		},
	);

	it.effect(
		"a snapshot under another program version is refused naming the process and both versions, and never fresh-boots",
		() => {
			const stores = memoryStores();
			const probe = probeOf();
			return Effect.gen(function* () {
				const id = yield* Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* processes.spawn(counter);
					yield* handle.dispatch({type: "tick"});
					return handle.id;
				}).pipe(Effect.provide(kernel([counterProgram(probe, stores)], stores)));

				yield* Effect.gen(function* () {
					const table = yield* ProcessTable;
					const refused = yield* restore.pipe(Effect.flip);
					assert.instanceOf(refused, SnapshotRefused);
					assert.strictEqual(refused.processId, id);
					assert.deepStrictEqual(refused.found, {programId: "counter", version: "1.0.0"});
					assert.deepStrictEqual(refused.expected, {programId: "counter", version: "2.0.0"});
					assert.include(refused.message, id);
					assert.include(refused.message, "counter@1.0.0");
					assert.include(refused.message, "counter@2.0.0");
					assert.deepStrictEqual(yield* table.list, []);
					assert.deepStrictEqual(probe.log, ["notify:1"]);
				}).pipe(Effect.provide(kernel([counterProgram(probe, stores, "2.0.0")], stores)));

				const snapshot = parseSnapshot(yield* io(() => stores.snapshot(id).load()));
				assert.deepStrictEqual(snapshot, {
					programId: "counter",
					version: "1.0.0",
					state: {count: 1, acks: 1},
				});
			});
		},
	);

	it.effect(
		"bytes on disk that are not a snapshot are refused the same way, not booted over",
		() => {
			const id = ProcessId.make("garbage");
			const probe = probeOf();
			return Effect.gen(function* () {
				const dir = yield* io(() => mkdtemp(join(tmpdir(), "tuval-durability-")));
				yield* io(() => mkdir(join(dir, "processes")));
				yield* io(() =>
					writeFile(
						join(dir, "manifest.json"),
						JSON.stringify({processes: [{id, programId: "counter", parentId: null}]}),
					),
				);
				yield* io(() =>
					writeFile(join(dir, "processes", `${id}.json`), JSON.stringify({nope: true})),
				);
				const stores = fileStores(dir);
				yield* Effect.gen(function* () {
					const table = yield* ProcessTable;
					const refused = yield* restore.pipe(Effect.flip);
					assert.instanceOf(refused, SnapshotMalformed);
					assert.strictEqual(refused.processId, id);
					assert.deepStrictEqual(yield* table.list, []);
				}).pipe(Effect.provide(kernel([counterProgram(probe, stores)], stores)));
				yield* io(() => rm(dir, {recursive: true, force: true}));
			});
		},
	);

	it.effect("fileStores checkpoints to disk through Demlik's fileStore and restores from it", () =>
		Effect.gen(function* () {
			const dir = yield* io(() => mkdtemp(join(tmpdir(), "tuval-durability-")));
			const stores = fileStores(dir);
			const probe = probeOf();
			const rows = [counterProgram(probe, stores)];

			const id = yield* Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* processes.spawn(counter);
				yield* handle.dispatch({type: "tick"});
				return handle.id;
			}).pipe(Effect.provide(kernel(rows, stores)));

			const onDisk = JSON.parse(
				yield* io(() => readFile(join(dir, "processes", `${id}.json`), "utf8")),
			);
			assert.deepStrictEqual(onDisk, {
				programId: "counter",
				version: "1.0.0",
				state: {count: 1, acks: 1},
			});
			assert.deepStrictEqual(
				JSON.parse(yield* io(() => readFile(join(dir, "manifest.json"), "utf8"))),
				{processes: [{id, programId: "counter", parentId: null}]},
			);

			yield* Effect.gen(function* () {
				const restored = yield* restore;
				assert.strictEqual(restored[0]!.id, id);
				assert.deepStrictEqual(restored[0]!.getState(), {count: 1, acks: 1});
				assert.deepStrictEqual(probe.log, ["notify:1"]);
			}).pipe(Effect.provide(kernel(rows, stores)));

			yield* io(() => rm(dir, {recursive: true, force: true}));
		}),
	);
});
