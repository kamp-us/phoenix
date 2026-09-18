/**
 * Durability is native to the kernel (#7514): every process opens its checkpoint here before
 * its actor boots, and the host does the rest — Demlik's save-before-effects ordering runs over
 * the `Store` this hands back (`commit` in `../host/actor.ts`), so there is no second
 * persistence path. `open` is an acquire/release under the process Scope: acquire loads the
 * snapshot, migrates one written under an older version of the same program where the row declares
 * that step and refuses one it cannot reach the current version from, records the process in the
 * manifest and takes the hold; release drops the hold. A refusal fails the spawn — the process is
 * never fresh-booted over its own snapshot (#7467, and the founder ruling on #8907:
 * https://github.com/kamp-us/phoenix/issues/8907#issuecomment-5625300780, which admitted the
 * migration and moved nothing else).
 *
 * A snapshot the program itself cannot restore (`CheckpointTarget.restorable`) is not refused
 * here — the program boots on its own refusal — but the store is sealed against writing, so
 * the bytes it could not read survive every later boot instead of being overwritten by the
 * state that refused them (#8112).
 *
 * `forget` is the one operation that subtracts (#9446). Everything else here appends: `record`
 * adds a manifest row at every `open` and nothing used to take one away, so `./restore.ts` replayed
 * every process that ever ran. Forgetting a process forgets its whole subtree, because the founder
 * ruled a removal takes the descendants with it, and it is deliberately not the inverse of `open`:
 * the process may still be running when its checkpoint is dropped, and `../process/Processes.ts`
 * relies on exactly that to write the durable half before it closes the Scope.
 */

import type {Store} from "@demlik/tea";
import {Context, Effect, Layer, Option, type Scope} from "effect";
import {StoreError} from "../host/errors.ts";
import {ProcessId} from "../process/process.ts";
import type {Migrations, ProgramId} from "../registry/program.ts";
import {CheckpointHeld, ManifestMalformed, SnapshotMalformed, SnapshotRefused} from "./errors.ts";
import {migrateState} from "./migrations.ts";
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
	/**
	 * The program's current definition version. A snapshot under any other reaches this one through
	 * the row's own `migrations` or is refused.
	 */
	readonly version: string;
	/**
	 * The program's declared walk from an older version to `version` (`Program.migrations`), keyed by
	 * the version on disk. Absent means every other version is refused, which is the answer for a
	 * program that has never changed its state shape.
	 */
	readonly migrations?: Migrations;
	/**
	 * The program's own read of a raw checkpoint (`Program.restorable`). A snapshot it answers
	 * `false` for seals this store: nothing is written over those bytes for the process's life.
	 * Absent means every snapshot is restorable, which is the answer for a program with no parse.
	 */
	readonly restorable?: (raw: unknown) => boolean;
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

/** What a `forget` fails with: the manifest it reads back, and the writes it makes from it. */
export type ForgetError = ManifestMalformed | StoreError;

export class Checkpoints extends Context.Service<
	Checkpoints,
	{
		readonly open: (
			target: CheckpointTarget,
		) => Effect.Effect<OpenedCheckpoint, OpenError, Scope.Scope>;
		/** Every checkpointed process, parents before children. */
		readonly list: Effect.Effect<ReadonlyArray<ManifestEntry>, ManifestMalformed | StoreError>;
		/**
		 * Drop the process and its whole subtree from the durable store: every collected
		 * `processes/<id>.json`, then the manifest rows in one write. An id the manifest does not
		 * carry forgets nothing and succeeds — there is nothing left to replay, which is the whole
		 * of what this promises.
		 */
		readonly forget: (id: ProcessId) => Effect.Effect<void, ForgetError>;
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

/**
 * The subtree rooted at `id`, parents before children, read off the manifest's own `parentId`
 * links. Grown a generation at a time rather than by recursion: an id is collected once, and only
 * a row whose parent is already collected joins the next pass, so a manifest whose rows name each
 * other as parents terminates instead of looping.
 */
const subtreeOf = (manifest: Manifest, id: ProcessId): ReadonlyArray<string> => {
	const collected = new Set<string>();
	if (manifest.processes.some((entry) => entry.id === id)) collected.add(id);
	for (let grew = collected.size > 0; grew; ) {
		grew = false;
		for (const entry of manifest.processes) {
			if (collected.has(entry.id) || entry.parentId === null) continue;
			if (!collected.has(entry.parentId)) continue;
			collected.add(entry.id);
			grew = true;
		}
	}
	return [...collected];
};

const makeService = (stores: CheckpointStores): Checkpoints["Service"] => {
	const held = new Set<ProcessId>();
	/**
	 * Ids `forget` has dropped whose process is still running — the ordinary case, since the durable
	 * half is written before the Scope closes. Their stores are sealed for the rest of that life, so
	 * a commit landing in the window between the forget and the close cannot write the snapshot back
	 * under a manifest that no longer names it. A later `open` at the same id is a new life and
	 * clears the seal.
	 */
	const forgotten = new Set<ProcessId>();

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
		const refuse = new SnapshotRefused({
			processId: target.id,
			expected: {programId: target.programId, version: target.version},
			found: {programId: snapshot.programId, version: snapshot.version},
		});
		// Another program altogether is refused before any walk: a migration is declared against this
		// program's own past versions, and nothing makes one program's state another's.
		if (snapshot.programId !== target.programId) return yield* refuse;
		if (snapshot.version === target.version) return snapshot;
		const migrated = migrateState(
			target.migrations,
			snapshot.version,
			target.version,
			snapshot.state,
		);
		if (Option.isNone(migrated)) return yield* refuse;
		return {programId: target.programId, version: target.version, state: migrated.value};
	});

	const dropSnapshot = (id: string) =>
		Effect.tryPromise({
			try: () => stores.dropSnapshot(ProcessId.make(id)),
			catch: (cause) => new StoreError({operation: "drop", cause}),
		});

	/**
	 * Snapshots first and descendants before their parent, then the manifest once, last. The order
	 * is what makes a crash mid-forget survivable: what it leaves behind is orphaned snapshot bytes,
	 * and `./restore.ts` reads the manifest, so nothing replays. Writing the manifest first would
	 * leave the mirror image — rows whose snapshots are gone, which is a refused boot.
	 */
	const forget = Effect.fn("Tuval.Checkpoints.forget")(function* (id: ProcessId) {
		const manifest = yield* loadManifest;
		const subtree = subtreeOf(manifest, id);
		if (subtree.length === 0) return;
		const dropped = new Set(subtree);
		for (const doomed of [...subtree].reverse()) yield* dropSnapshot(doomed);
		yield* save(stores.manifest, {
			processes: manifest.processes.filter((entry) => !dropped.has(entry.id)),
		});
		// Sealed only once the manifest write has landed. A forget that failed has removed nothing —
		// the rows are all still there and the processes all still running — so sealing their stores
		// would freeze a state the store is still expected to carry.
		for (const forgot of subtree) forgotten.add(ProcessId.make(forgot));
	});

	const acquire = Effect.fn("Tuval.Checkpoints.acquire")(function* (target: CheckpointTarget) {
		if (held.has(target.id)) return yield* new CheckpointHeld({processId: target.id});
		forgotten.delete(target.id);
		const backing = stores.snapshot(target.id);
		const snapshot = yield* loadSnapshot(target, backing);
		yield* record(target);
		held.add(target.id);
		const sealed = snapshot !== null && target.restorable?.(snapshot.state) === false;
		const store: Store<unknown> = {
			load: () => Promise.resolve(snapshot === null ? null : snapshot.state),
			save: (state) =>
				sealed || forgotten.has(target.id)
					? Promise.resolve()
					: backing.save({programId: target.programId, version: target.version, state}),
			migrate: (raw) => raw,
		};
		return {store, restored: snapshot !== null} satisfies OpenedCheckpoint;
	});

	return Checkpoints.of({
		open: (target) =>
			Effect.acquireRelease(acquire(target), () => Effect.sync(() => void held.delete(target.id))),
		list: Effect.map(loadManifest, (manifest) => manifest.processes),
		forget,
	});
};
