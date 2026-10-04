/**
 * What durability writes through Demlik's stores, and nothing else does (#7514): one `Snapshot`
 * per process — the machine state under the program version that produced it — and one
 * `Manifest` naming every checkpointed process in spawn order, parents before children, which is
 * the order restore spawns them back in. Both are plain data; no Effect value ever enters either.
 */

import {Option, Schema} from "effect";

export const Snapshot = Schema.Struct({
	programId: Schema.String,
	version: Schema.String,
	state: Schema.Unknown,
});
export type Snapshot = typeof Snapshot.Type;

export const ManifestEntry = Schema.Struct({
	id: Schema.String,
	programId: Schema.String,
	parentId: Schema.NullOr(Schema.String),
});
export type ManifestEntry = typeof ManifestEntry.Type;

export const Manifest = Schema.Struct({processes: Schema.Array(ManifestEntry)});
export type Manifest = typeof Manifest.Type;

export const emptyManifest: Manifest = {processes: []};

/** Demlik's `Store.migrate` contract: a shape the schema rejects is `null`, never a throw. */
export const parseSnapshot = (raw: unknown): Snapshot | null =>
	Option.getOrNull(Schema.decodeUnknownOption(Snapshot)(raw));

export const parseManifest = (raw: unknown): Manifest | null =>
	Option.getOrNull(Schema.decodeUnknownOption(Manifest)(raw));
