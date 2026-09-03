/**
 * Durability is native to the kernel (#7514): every process opens its checkpoint here before
 * its actor boots, and the host does the rest — Demlik's save-before-effects ordering runs over
 * the `Store` this hands back (`commit` in `../host/actor.ts`), so there is no second
 * persistence path. `open` is an acquire/release under the process Scope: acquire loads the
 * snapshot, refuses one written under another definition, records the process in the manifest
 * and takes the hold; release drops the hold. A refusal fails the spawn — the process is never
 * fresh-booted over its own snapshot (#7467).
 */

import type {Store} from "@demlik/tea";
import {Context, Effect, Layer, Option, type Scope} from "effect";
import {StoreError} from "../host/errors.ts";
import type {ProcessId} from "../process/process.ts";
import type {ProgramId} from "../registry/program.ts";
import {CheckpointHeld, ManifestMalformed, SnapshotMalformed, SnapshotRefused} from "./errors.ts";
import {
	emptyManifest,
	type Manifest,
	type ManifestEntry,
	parseManifest,
	parseSnapshot,
	type Snapshot,
} from "./snapshot.ts";
import type {CheckpointStores} from "./stores.ts";

export interface CheckpointTarget {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: Option.Option<ProcessId>;
	/** The program's current definition version; a snapshot under any other is refused. */
	readonly version: string;
}

export interface OpenedCheckpoint {
	/** For the host: loads the restored state (or `null` on a fresh spawn), saves the snapshot. */
	readonly store: Store<unknown>;
	readonly restored: boolean;
}

export type OpenError =
	| SnapshotRefused
	| SnapshotMalformed
	| ManifestMalformed
	| CheckpointHeld
	| StoreError;

export class Checkpoints extends Context.Service<
	Checkpoints,
	{
		readonly open: (
			target: CheckpointTarget,
		) => Effect.Effect<OpenedCheckpoint, OpenError, Scope.Scope>;
		/** Every checkpointed process, parents before children. */
		readonly list: Effect.Effect<ReadonlyArray<ManifestEntry>, ManifestMalformed | StoreError>;
	}
>()("tuval/Checkpoints") {
	static readonly layer = (stores: CheckpointStores): Layer.Layer<Checkpoints> =>
		Layer.succeed(Checkpoints, makeService(stores));
}

const load = <S>(store: Store<S>) =>
	Effect.tryPromise({
		try: () => store.load(),
		catch: (cause) => new StoreError({operation: "load", cause}),
	});

const save = <S>(store: Store<S>, state: S) =>
	Effect.tryPromise({
		try: () => store.save(state),
		catch: (cause) => new StoreError({operation: "save", cause}),
	});

const makeService = (stores: CheckpointStores): Checkpoints["Service"] => {
	const held = new Set<ProcessId>();

	const loadManifest = Effect.gen(function* () {
		const raw = yield* load(stores.manifest);
		if (raw === null) return emptyManifest;
		const manifest = parseManifest(raw);
		if (manifest === null) return yield* new ManifestMalformed();
		return manifest;
	});

	const record = Effect.fn("Tuval.Checkpoints.record")(function* (target: CheckpointTarget) {
		const manifest = yield* loadManifest;
		if (manifest.processes.some((entry) => entry.id === target.id)) return;
		const next: Manifest = {
			processes: [
				...manifest.processes,
				{
					id: target.id,
					programId: target.programId,
					parentId: Option.getOrNull(target.parentId),
				},
			],
		};
		yield* save(stores.manifest, next);
	});

	const loadSnapshot = Effect.fn("Tuval.Checkpoints.loadSnapshot")(function* (
		target: CheckpointTarget,
		store: Store<Snapshot>,
	) {
		const raw = yield* load(store);
		if (raw === null) return null;
		const snapshot = parseSnapshot(raw);
		if (snapshot === null) return yield* new SnapshotMalformed({processId: target.id});
		if (snapshot.programId !== target.programId || snapshot.version !== target.version) {
			return yield* new SnapshotRefused({
				processId: target.id,
				expected: {programId: target.programId, version: target.version},
				found: {programId: snapshot.programId, version: snapshot.version},
			});
		}
		return snapshot;
	});

	const acquire = Effect.fn("Tuval.Checkpoints.acquire")(function* (target: CheckpointTarget) {
		if (held.has(target.id)) return yield* new CheckpointHeld({processId: target.id});
		const backing = stores.snapshot(target.id);
		const snapshot = yield* loadSnapshot(target, backing);
		yield* record(target);
		held.add(target.id);
		const store: Store<unknown> = {
			load: () => Promise.resolve(snapshot === null ? null : snapshot.state),
			save: (state) => backing.save({programId: target.programId, version: target.version, state}),
			migrate: (raw) => raw,
		};
		return {store, restored: snapshot !== null} satisfies OpenedCheckpoint;
	});

	return Checkpoints.of({
		open: (target) =>
			Effect.acquireRelease(acquire(target), () => Effect.sync(() => void held.delete(target.id))),
		list: Effect.map(loadManifest, (manifest) => manifest.processes),
	});
};
