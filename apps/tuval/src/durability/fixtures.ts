/**
 * Test fixtures for the durability slice: memory stores with a tap on every write.
 *
 * `Checkpoints.forget` promises an order — snapshots before the manifest, descendants before their
 * parent — and an order is not visible in the end state a test could read back. So the writes are
 * recorded as they happen, and a test asserts the sequence. `refuseManifestSave` is the other half:
 * the durable write a removal cannot land, which is what `Processes.remove` refuses on.
 */

import {Effect, Schema} from "effect";
import type {ProcessId} from "../process/process.ts";
import {parseSnapshot, type Snapshot} from "./snapshot.ts";
import {type CheckpointStores, memoryStores} from "./stores.ts";

export interface WatchedStores {
	readonly stores: CheckpointStores;
	/** Every durable write in order: `manifest:save`, `snapshot:drop:<id>`. */
	readonly writes: Array<string>;
	/** While true, every manifest write rejects. */
	refuseManifestSave: boolean;
}

/**
 * `memoryStores()` under a tap. The log is the caller's own array when it has one — a test that
 * needs a program's own events and these writes on one timeline (the ordering proof for
 * `Processes.remove`) passes the probe log it is already collecting into.
 */
export const watchingStores = (writes: Array<string> = []): WatchedStores => {
	const backing = memoryStores();
	const watched: WatchedStores = {
		writes,
		refuseManifestSave: false,
		stores: {
			manifest: {
				load: () => backing.manifest.load(),
				save: (state) =>
					watched.refuseManifestSave
						? Promise.reject(new Error("the manifest store is down"))
						: backing.manifest.save(state).then(() => void writes.push("manifest:save")),
				migrate: (raw) => backing.manifest.migrate(raw),
			},
			snapshot: (id: ProcessId) => backing.snapshot(id),
			dropSnapshot: (id: ProcessId) =>
				backing.dropSnapshot(id).then(() => void writes.push(`snapshot:drop:${id}`)),
		},
	};
	return watched;
};

/** A read of a snapshot store rejected — a test's own probe, never a production path. */
export class SnapshotProbeFailed extends Schema.TaggedError<SnapshotProbeFailed>()(
	"tuval/durability/SnapshotProbeFailed",
	{cause: Schema.Defect()},
) {}

/** What is on the snapshot store for one process, or `null` — the shape a forget leaves behind. */
export const snapshotAt = (
	stores: CheckpointStores,
	id: ProcessId,
): Effect.Effect<Snapshot | null, SnapshotProbeFailed> =>
	Effect.map(
		Effect.tryPromise({
			try: () => stores.snapshot(id).load(),
			catch: (cause) => new SnapshotProbeFailed({cause}),
		}),
		parseSnapshot,
	);
