/**
 * The two Demlik store shapes durability is built over — the only persistence path (#7514).
 * `fileStores(dir)` is the local app's: Demlik's `fileStore` (atomic temp+rename; an absent file
 * loads `null`) at `<dir>/manifest.json` and `<dir>/processes/<id>.json`. `memoryStores()` is
 * the test tier's: Demlik's `memoryStore`, one per process, kept in a map so a second kernel
 * built over the same object is a reload.
 */

import {join} from "node:path";
import type {Store} from "@demlik/tea";
import {memoryStore} from "@demlik/tea/mem";
import {fileStore} from "@demlik/tea/node";
import type {ProcessId} from "../process/process.ts";
import {type Manifest, parseManifest, parseSnapshot, type Snapshot} from "./snapshot.ts";

export interface CheckpointStores {
	readonly manifest: Store<Manifest>;
	readonly snapshot: (id: ProcessId) => Store<Snapshot>;
}

export const fileStores = (dir: string): CheckpointStores => ({
	manifest: fileStore(join(dir, "manifest.json"), parseManifest),
	snapshot: (id) => fileStore(join(dir, "processes", `${id}.json`), parseSnapshot),
});

export const memoryStores = (): CheckpointStores => {
	const snapshots = new Map<ProcessId, Store<Snapshot>>();
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
