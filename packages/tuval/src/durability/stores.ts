/**
 * The two Demlik store shapes durability is built over — the only persistence path (#7514).
 * `fileStores(dir)` is the local app's: Demlik's `fileStore` (atomic temp+rename; an absent file
 * loads `null`) at `<dir>/manifest.json` and `<dir>/processes/<id>.json`. `memoryStores()` is
 * the test tier's: Demlik's `memoryStore`, one per process, kept in a map so a second kernel
 * built over the same object is a reload.
 */

import {rm} from "node:fs/promises";
import {join} from "node:path";
import type {Store} from "@demlik/tea";
import {memoryStore} from "@demlik/tea/mem";
import {fileStore} from "@demlik/tea/node";
import type {ProcessId} from "../process/process.ts";
import {type Manifest, parseManifest, parseSnapshot, type Snapshot} from "./snapshot.ts";

export interface CheckpointStores {
	readonly manifest: Store<Manifest>;
	readonly snapshot: (id: ProcessId) => Store<Snapshot>;
	/**
	 * Drop the process's snapshot bytes — what `Checkpoints.forget` needs and Demlik's `Store` has
	 * no word for: it loads and saves, and a snapshot saved as `null` is not a snapshot. Dropping is
	 * idempotent, because a store never written and one whose bytes are gone both load `null`.
	 */
	readonly dropSnapshot: (id: ProcessId) => Promise<void>;
}

const snapshotPath = (dir: string, id: ProcessId) => join(dir, "processes", `${id}.json`);

export const fileStores = (dir: string): CheckpointStores => ({
	manifest: fileStore(join(dir, "manifest.json"), parseManifest),
	snapshot: (id) => fileStore(snapshotPath(dir, id), parseSnapshot),
	// `force` is the idempotence: a process that never committed has no file, and a forget of one
	// is a success rather than the ENOENT that would refuse the whole removal.
	dropSnapshot: (id) => rm(snapshotPath(dir, id), {force: true}),
});

export const memoryStores = (): CheckpointStores => {
	// One cell per id, and the store handed out is a view onto it rather than the cell itself, so a
	// drop empties the cell in place the way `rm` empties a path: a process that acquired its store
	// before the drop keeps writing to the same cell a later reader loads from. Deleting the map
	// entry instead would hand the next reader a fresh empty cell while the live process's saves
	// land in a detached one — a store that lies about exactly the window `forget` is built for.
	const cells = new Map<ProcessId, {value: Snapshot | null}>();
	const cellFor = (id: ProcessId): {value: Snapshot | null} => {
		let cell = cells.get(id);
		if (cell === undefined) {
			cell = {value: null};
			cells.set(id, cell);
		}
		return cell;
	};
	return {
		manifest: memoryStore<Manifest>(null, parseManifest),
		snapshot: (id) => {
			const cell = cellFor(id);
			return {
				load: () => Promise.resolve(cell.value),
				save: (snapshot) => {
					cell.value = snapshot;
					return Promise.resolve();
				},
				migrate: (raw) => parseSnapshot(raw),
			};
		},
		dropSnapshot: (id) => {
			const cell = cells.get(id);
			if (cell !== undefined) cell.value = null;
			return Promise.resolve();
		},
	};
};
