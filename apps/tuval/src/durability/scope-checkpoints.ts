/**
 * The one-time move of a desk's saved checkpoints onto project-scoped ids (#9684). Before project
 * scoping, a project row ran under its bare id and a graph node's process took the node's bare id;
 * now both run under `<project>/<id>`. Left alone, a checkpoint from before would name a program the
 * registry no longer holds, and restoring it would refuse the boot.
 *
 * So the first boot on this build moves them: a manifest entry whose program is one of the project
 * layer's rows is re-pointed at that row's scoped id, an entry whose process id is one of the project
 * layer's graph nodes takes that node's scoped id, and a parent link follows its parent. Each moved
 * snapshot is written under its new id before the old one is deleted, and the manifest is written
 * last. A marker in the state directory records that the move ran, because after it a bare program id
 * in the manifest means a global row and must not be moved again.
 */

import {join} from "node:path";
import type {Store} from "@demlik/tea";
import {
	type Manifest,
	type ManifestEntry,
	parseManifest,
	parseSnapshot,
} from "@kampus/tuval-sdk/kernel/durability/snapshot";
import type {CheckpointStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Effect, FileSystem, Schema} from "effect";
import type {ProjectId} from "../project-id.ts";

/** The state-directory file whose presence says this directory's checkpoints are already scoped. */
export const SCOPED_IDS_MARKER = "scoped-ids.json";

export class CheckpointScopingFailed extends Schema.TaggedError<CheckpointScopingFailed>()(
	"tuval/CheckpointScopingFailed",
	{stateDir: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `could not move the checkpoints in ${this.stateDir} onto project-scoped ids: ${this.reason}`;
	}
}

/** The local ids the project layer declares: its rows and its graph nodes. */
export interface ProjectOwned {
	readonly programs: ReadonlySet<string>;
	readonly nodes: ReadonlySet<string>;
}

/** What one boot's move did: the process ids it moved, each beside the id it now runs under. */
export interface CheckpointScoping {
	readonly moved: ReadonlyArray<{readonly from: string; readonly to: string}>;
}

const nothingMoved: CheckpointScoping = {moved: []};

export const scopeCheckpoints = Effect.fn("Tuval.scopeCheckpoints")(function* (
	stateDir: string,
	stores: CheckpointStores,
	project: ProjectId,
	owned: ProjectOwned,
) {
	const fs = yield* FileSystem.FileSystem;
	const marker = join(stateDir, SCOPED_IDS_MARKER);
	if (yield* fs.exists(marker)) return nothingMoved;
	const fail = (reason: string) => new CheckpointScopingFailed({stateDir, reason});
	const attempt = <A>(what: string, run: () => Promise<A>) =>
		Effect.tryPromise({try: run, catch: (cause) => fail(`${what}: ${String(cause)}`)});
	const load = <S>(store: Store<S>, what: string) => attempt(what, () => store.load());

	const raw = yield* load(stores.manifest, "reading the manifest");
	const manifest: Manifest | null = raw === null ? {processes: []} : parseManifest(raw);
	// A manifest that does not parse is `Checkpoints`' refusal to make, not this move's: it is left
	// as it is and the marker unwritten, so the boot refuses where it always has.
	if (manifest === null) return nothingMoved;

	const processOf = (id: string) => (owned.nodes.has(id) ? project.scope(id) : id);
	const programOf = (id: string) => (owned.programs.has(id) ? project.scope(id) : id);
	const scoped = manifest.processes.map(
		(entry): ManifestEntry => ({
			id: processOf(entry.id),
			programId: programOf(entry.programId),
			parentId: entry.parentId === null ? null : processOf(entry.parentId),
		}),
	);
	const moved: Array<{readonly from: string; readonly to: string}> = [];
	for (const [at, entry] of manifest.processes.entries()) {
		const next = scoped[at] as ManifestEntry;
		if (next.id === entry.id && next.programId === entry.programId) continue;
		const from = stores.snapshot(ProcessId.make(entry.id));
		const snapshot = parseSnapshot(yield* load(from, `reading ${entry.id}`));
		if (snapshot !== null) {
			const to = stores.snapshot(ProcessId.make(next.id));
			yield* attempt(`writing ${next.id}`, () => to.save({...snapshot, programId: next.programId}));
			if (next.id !== entry.id) yield* attempt(`deleting ${entry.id}`, () => from.delete());
		}
		moved.push({from: entry.id, to: next.id});
	}
	if (JSON.stringify(scoped) !== JSON.stringify(manifest.processes)) {
		yield* attempt("writing the manifest", () => stores.manifest.save({processes: scoped}));
	}
	yield* fs
		.writeFileString(marker, `${JSON.stringify({version: 1}, null, "\t")}\n`)
		.pipe(Effect.mapError((error) => fail(`writing ${SCOPED_IDS_MARKER}: ${error.message}`)));
	return {moved} satisfies CheckpointScoping;
});
