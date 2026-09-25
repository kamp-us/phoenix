/**
 * The two Demlik store shapes durability is built over — the only persistence path (#7514).
 * `fileStores(dir)` is the local app's: Demlik's `fileStore` (atomic temp+rename; an absent file
 * loads `null`) at `<dir>/manifest.json` and `<dir>/processes/<id>.json`. `memoryStores()` is
 * the test tier's: Demlik's `memoryStore`, one per process, kept in a map so a second kernel
 * built over the same object is a reload.
 */

import {join} from "node:path";
import type {DeletableStore, Store} from "@demlik/tea";
import {memoryStore} from "@demlik/tea/mem";
import {fileStore} from "@demlik/tea/node";
import type {ProcessId} from "../process/process.ts";
import {type Manifest, parseManifest, parseSnapshot, type Snapshot} from "./snapshot.ts";

export interface CheckpointStores {
	readonly manifest: Store<Manifest>;
	/**
	 * A process's snapshot store. Deletable, because `Checkpoints.forget` removes a save through the
	 * store that wrote it (demlik #314) and never through the path under it; tea's `delete()` is
	 * idempotent, so forgetting a process that never committed succeeds.
	 */
	readonly snapshot: (id: ProcessId) => DeletableStore<Snapshot>;
}

export const fileStores = (dir: string): CheckpointStores => ({
	manifest: fileStore(join(dir, "manifest.json"), parseManifest),
	snapshot: (id) => fileStore(join(dir, "processes", `${id}.json`), parseSnapshot),
});

export const memoryStores = (): CheckpointStores => {
	// One store per id, handed out again on every ask, so a delete empties the same store a live
	// process is still writing to — the way a file store's delete empties the path it writes. A fresh
	// store per ask would let the live process's saves land where no later reader looks.
	const snapshots = new Map<ProcessId, DeletableStore<Snapshot>>();
	return {
		manifest: memoryStore<Manifest>(null, parseManifest),
		snapshot: (id) => {
			let store = snapshots.get(id);
			if (store === undefined) {
				store = memoryStore<Snapshot>(null, parseSnapshot);
				snapshots.set(id, store);
			}
			return store;
		},
	};
};
