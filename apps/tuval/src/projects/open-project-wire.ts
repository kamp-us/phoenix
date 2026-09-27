/**
 * The answers the picker's "Open project…" reads off the kernel (#9697, ruling #9668 R6.1): the
 * recently opened folders, one folder's subfolders, and what an open did. Each is a `project` spell's
 * result (`./spells.ts`), declared once here so the kernel encodes and the page decodes one schema.
 * It imports nothing from Node, because the page imports it.
 */

import {Schema} from "effect";

/** One recently opened folder. `key` is the id its rows are scoped by (`../project-id.ts`). */
export const RecentProjectRow = Schema.Struct({
	folder: Schema.String,
	name: Schema.String,
	key: Schema.String,
	open: Schema.Boolean,
});
export type RecentProjectRow = typeof RecentProjectRow.Type;

export const RecentProjects = Schema.Array(RecentProjectRow);

/** One folder inside the folder being browsed. */
export const BrowsedFolder = Schema.Struct({
	name: Schema.String,
	folder: Schema.String,
	/** It holds a `.tuval/tuval.config.ts`, so opening it runs its programs, after the trust prompt. */
	hasConfig: Schema.Boolean,
	/** It is open in this desk now. */
	open: Schema.Boolean,
});
export type BrowsedFolder = typeof BrowsedFolder.Type;

/** A folder named with its display name, for a row that points at it. */
export const NamedFolder = Schema.Struct({folder: Schema.String, name: Schema.String});

/** One folder's subfolders. `parent` is `null` at the root of the file system. */
export const FolderListing = Schema.Struct({
	folder: Schema.String,
	name: Schema.String,
	/** The id the folder's rows would be scoped by, were it open (`../project-id.ts`). */
	key: Schema.String,
	parent: Schema.NullOr(NamedFolder),
	/** The folder being browsed is itself open in this desk now. */
	open: Schema.Boolean,
	folders: Schema.Array(BrowsedFolder),
});
export type FolderListing = typeof FolderListing.Type;

/** What an open did, as far as the picker reads it. The spell's result carries more. */
export const OpenedProject = Schema.Struct({
	folder: Schema.String,
	name: Schema.String,
	key: Schema.String,
});
export type OpenedProject = typeof OpenedProject.Type;
