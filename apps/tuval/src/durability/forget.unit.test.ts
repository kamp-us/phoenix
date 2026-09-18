/**
 * `Checkpoints.forget` and the restart it is built for (#9446). Everything else in this directory
 * appends; this is the one operation that subtracts, so what it is asked to prove is an order —
 * snapshots before the manifest, descendants before their parent — and an absence: a removed
 * process comes back from neither half of the store.
 *
 * The stores are memory stores under a watcher that records every write, because the order is not
 * visible in the end state: a forget that wrote the manifest first and then died leaves exactly the
 * store a correct one leaves, minus the crash nobody ran.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId} from "../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {snapshotAt, watchingStores} from "./fixtures.ts";
import {restore} from "./restore.ts";
import {type CheckpointStores, memoryStores} from "./stores.ts";

type State = {readonly count: number};
type Msg = {readonly type: "tick"};

const counter = ProgramId.make("counter");

const counterProgram: AnyProgram = {
	id: counter,
	core: defineMachine<State, Msg, never, never, unknown>({
		init: (loaded) => [loaded ?? {count: 0}, []],
		update: {tick: (state) => [{count: state.count + 1}, []]},
	}),
	ports: {},
	handlers: {},
	capabilities: [],
	identity: {package: "@kampus/tuval", program: "counter", version: "1.0.0", digest: "sha256:c"},
	placement: {host: "local"},
} satisfies Program<State, Msg, never, never, unknown, never, never>;

const kernel = (stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provideMerge(Registry.layer([counterProgram])),
	);

/** A root with a child and a grandchild, each carrying a snapshot of its own. */
const threeDeep = Effect.gen(function* () {
	const processes = yield* Processes;
	const root = yield* processes.spawn(counter, {services: Context.empty()});
	const child = yield* processes.spawn(counter, {parent: root.id, services: Context.empty()});
	const grandchild = yield* processes.spawn(counter, {
		parent: child.id,
		services: Context.empty(),
	});
	for (const handle of [root, child, grandchild]) yield* handle.dispatch({type: "tick"});
	return {root: root.id, child: child.id, grandchild: grandchild.id};
});

describe("Checkpoints.forget", () => {
	it.effect("drops the whole subtree: snapshots descendants-first, then the manifest once", () => {
		const watcher = watchingStores();
		return Effect.gen(function* () {
			const checkpoints = yield* Checkpoints;
			const {root, child, grandchild} = yield* threeDeep;
			watcher.writes.length = 0;

			yield* checkpoints.forget(root);

			assert.deepStrictEqual(watcher.writes, [
				`snapshot:drop:${grandchild}`,
				`snapshot:drop:${child}`,
				`snapshot:drop:${root}`,
				"manifest:save",
			]);
			assert.deepStrictEqual(yield* checkpoints.list, []);
			for (const id of [root, child, grandchild]) {
				assert.isNull(yield* snapshotAt(watcher.stores, id));
			}
		}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
	});

	it.effect("leaves a sibling subtree alone", () => {
		const watcher = watchingStores();
		return Effect.gen(function* () {
			const processes = yield* Processes;
			const checkpoints = yield* Checkpoints;
			const {root, child, grandchild} = yield* threeDeep;
			const sibling = yield* processes.spawn(counter, {services: Context.empty()});
			yield* sibling.dispatch({type: "tick"});

			yield* checkpoints.forget(child);

			assert.deepStrictEqual(
				(yield* checkpoints.list).map((entry) => entry.id),
				[root as string, sibling.id as string],
			);
			assert.isNull(yield* snapshotAt(watcher.stores, grandchild));
			assert.isNotNull(yield* snapshotAt(watcher.stores, sibling.id));
		}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
	});

	it.effect("forgets nothing, and writes nothing, for an id the manifest does not carry", () => {
		const watcher = watchingStores();
		return Effect.gen(function* () {
			const checkpoints = yield* Checkpoints;
			const {root} = yield* threeDeep;
			watcher.writes.length = 0;

			yield* checkpoints.forget(ProcessId.make("never-checkpointed"));

			assert.deepStrictEqual(watcher.writes, []);
			assert.deepStrictEqual((yield* checkpoints.list).map((entry) => entry.id)[0], root as string);
		}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
	});

	it.effect("surfaces a failed manifest write and leaves the manifest as it was", () => {
		const watcher = watchingStores();
		return Effect.gen(function* () {
			const checkpoints = yield* Checkpoints;
			const {root, child, grandchild} = yield* threeDeep;
			watcher.refuseManifestSave = true;

			const refused = yield* Effect.flip(checkpoints.forget(root));

			assert.strictEqual(refused._tag, "tuval/host/StoreError");
			watcher.refuseManifestSave = false;
			assert.deepStrictEqual(
				(yield* checkpoints.list).map((entry) => entry.id),
				[root as string, child as string, grandchild as string],
			);
		}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
	});

	/**
	 * The seal (`Checkpoints.ts`, `forgotten`). A forget runs while its processes are still alive —
	 * `Processes.remove` closes the Scope only after the store is clean — so a commit landing in that
	 * window must not write the snapshot back under a manifest that no longer names it. And a forget
	 * that was refused sealed nothing: the process still owns its rows, and its next commit rewrites
	 * the snapshot the failed attempt dropped.
	 */
	it.effect(
		"a commit after a forget writes no snapshot back; after a refused forget it does",
		() => {
			const watcher = watchingStores();
			return Effect.gen(function* () {
				const processes = yield* Processes;
				const checkpoints = yield* Checkpoints;
				const {root, grandchild} = yield* threeDeep;
				const live = Option.getOrThrow(yield* processes.handle(grandchild));

				yield* checkpoints.forget(root);
				yield* live.dispatch({type: "tick"});

				assert.isNull(yield* snapshotAt(watcher.stores, grandchild));
				assert.deepStrictEqual(yield* checkpoints.list, []);

				const other = yield* processes.spawn(counter, {services: Context.empty()});
				yield* other.dispatch({type: "tick"});
				watcher.refuseManifestSave = true;
				yield* Effect.flip(checkpoints.forget(other.id));
				watcher.refuseManifestSave = false;
				assert.isNull(yield* snapshotAt(watcher.stores, other.id));

				yield* other.dispatch({type: "tick"});

				assert.isNotNull(yield* snapshotAt(watcher.stores, other.id));
				assert.deepStrictEqual(
					(yield* checkpoints.list).map((entry) => entry.id),
					[other.id as string],
				);
			}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
		},
	);

	/**
	 * The seal's release. A forgotten id is not retired: the next `open` at it is a new life, and
	 * that life persists like any other — so a process spawned at a removed id checkpoints again.
	 * Delete the release and every `save` at that id resolves, writes nothing and reports success.
	 */
	it.effect("a later open at a forgotten id clears the seal and persists again", () => {
		const watcher = watchingStores();
		return Effect.gen(function* () {
			const processes = yield* Processes;
			const checkpoints = yield* Checkpoints;
			const {root, child, grandchild} = yield* threeDeep;

			yield* processes.remove(root);
			for (const id of [root, child, grandchild]) {
				assert.isNull(yield* snapshotAt(watcher.stores, id));
			}

			const reborn = yield* processes.spawn(counter, {id: root, services: Context.empty()});
			yield* reborn.dispatch({type: "tick"});

			assert.isNotNull(yield* snapshotAt(watcher.stores, root));
			assert.deepStrictEqual(
				(yield* checkpoints.list).map((entry) => entry.id),
				[root as string],
			);
		}).pipe(Effect.provide(kernel(watcher.stores)), Effect.orDie);
	});

	/**
	 * The epic's actual claim, over `memoryStores()` — which `./stores.ts` keeps in a map precisely
	 * so a second kernel built on the same object is a reload. Spawn, remove, rebuild: the removed
	 * process comes back from neither the manifest nor a snapshot, and its child does not outlive it.
	 */
	it.effect("a removed process is not brought back by the next kernel's restore", () => {
		const stores = memoryStores();
		return Effect.gen(function* () {
			const kept = yield* Effect.gen(function* () {
				const processes = yield* Processes;
				const {root} = yield* threeDeep;
				const survivor = yield* processes.spawn(counter, {services: Context.empty()});
				yield* survivor.dispatch({type: "tick"});
				yield* processes.remove(root);
				return survivor.id;
			}).pipe(Effect.provide(kernel(stores)));

			yield* Effect.gen(function* () {
				const restored = yield* restore(Context.empty());
				assert.deepStrictEqual(
					restored.map((handle) => handle.id),
					[kept],
				);
				assert.deepStrictEqual(
					(yield* ProcessTable.use((table) => table.list)).map((row) => row.id),
					[kept],
				);
			}).pipe(Effect.provide(kernel(stores)));
		}).pipe(Effect.orDie);
	});
});
