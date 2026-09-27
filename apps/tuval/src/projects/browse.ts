/**
 * One folder's subfolders, as the picker's folder browser lists them (#9697, ruling #9668 R6.1).
 * Only folders are listed, because only a folder opens as a project, and a dot-folder is left out
 * the way a file manager hides it by default. A folder that holds a `.tuval` config is marked, since
 * opening it runs code and asks for trust first.
 */

import {basename, dirname, join} from "node:path";
import {Effect, FileSystem, Schema} from "effect";
import {ProjectId, projectConfig} from "../project-id.ts";
import type {FolderListing} from "./open-project-wire.ts";

/** A folder the browser could not list. */
export class FolderUnreadable extends Schema.TaggedError<FolderUnreadable>()(
	"tuval/FolderUnreadable",
	{folder: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `could not read the folder ${this.folder}: ${this.reason}`;
	}
}

/** A folder's own name, or the path itself for the root, which has none. */
const nameOf = (folder: string): string => basename(folder) || folder;

const byName = new Intl.Collator(undefined, {numeric: true, sensitivity: "base"});

/**
 * The subfolders of `folder` (absolute), sorted by name the way a person reads them. `isOpen` says
 * whether a folder is open in the desk now. An entry that cannot be inspected is left out rather than
 * failing the listing: a dangling link beside a hundred good folders should not hide them.
 */
export const listFolders = Effect.fn("Tuval.listFolders")(function* (
	folder: string,
	isOpen: (folder: string) => boolean,
) {
	const fs = yield* FileSystem.FileSystem;
	const unreadable = (cause: {readonly message: string}) =>
		new FolderUnreadable({folder, reason: cause.message});
	const info = yield* fs.stat(folder).pipe(Effect.mapError(unreadable));
	if (info.type !== "Directory") {
		return yield* new FolderUnreadable({folder, reason: "it is not a folder"});
	}
	const names = yield* fs.readDirectory(folder).pipe(Effect.mapError(unreadable));
	const visible = names.filter((name) => !name.startsWith(".")).sort(byName.compare);
	const folders = yield* Effect.forEach(
		visible,
		(name) =>
			Effect.gen(function* () {
				const path = join(folder, name);
				const entry = yield* fs.stat(path);
				if (entry.type !== "Directory") return [];
				const hasConfig = yield* fs.exists(projectConfig(path));
				return [{name, folder: path, hasConfig, open: isOpen(path)}];
			}).pipe(Effect.orElseSucceed(() => [])),
		{concurrency: 16},
	);
	const parent = dirname(folder);
	return {
		folder,
		name: nameOf(folder),
		key: ProjectId.of(folder).key,
		parent: parent === folder ? null : {folder: parent, name: nameOf(parent)},
		open: isOpen(folder),
		folders: folders.flat(),
	} satisfies FolderListing;
});
