/**
 * Which folder a fresh session starts in (#9694, ruling #9668 R3.1). A session's folder is set
 * once, at start, and the checkpoint carries it from then on (`core/state.ts`'s `cwd`), so this
 * rule runs once per session and never again for it.
 *
 * Three sources, most specific first: the session the spawner named (`SessionOpening`, which the
 * session list uses to resume a stored session in its own folder), then a folder the row fixed for
 * itself, then the folder the spawner runs in (`WorkingFolder`). A row that fixes nothing is a row
 * that takes its folder at start (`Program.folderAtStart`).
 */

import {Option} from "effect";

export interface StartFolderSources {
	/** The folder of the session the spawner named, if it named one. */
	readonly opening: Option.Option<string>;
	/** The folder the row fixed for itself, or `null` for a row that takes one at start. */
	readonly row: string | null;
	/** The folder the spawner runs in, if the spawn set carries one. */
	readonly inherited: Option.Option<string>;
}

/** The folder, or none when no source names one: the session then refuses to start. */
export const startFolder = (sources: StartFolderSources): Option.Option<string> =>
	Option.orElse(sources.opening, () =>
		sources.row === null ? sources.inherited : Option.some(sources.row),
	);
