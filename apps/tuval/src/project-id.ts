/**
 * Which project a program row or graph node belongs to (#9684, ruling #9668 R4.1). The identity is
 * the ADR 0402 path key, the same name the project's state directory is keyed by, so two folders
 * are two projects even when their folder names match. The folder's own name is only what a person
 * is shown.
 */

import {basename, join} from "node:path";
import {scopedId, scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {projectKey} from "@kampus/tuval-sdk/kernel/state-dir";

export class ProjectId {
	/** The ADR 0402 key of the folder's path: what scopes this project's ids. */
	readonly key: string;
	/** The folder's name, for display. Not unique, so nothing is keyed on it. */
	readonly name: string;

	private constructor(key: string, name: string) {
		this.key = key;
		this.name = name;
	}

	/** The project at `folder`, keyed exactly as its state directory is (`homeStateDir`). */
	static of(folder: string): ProjectId {
		return new ProjectId(projectKey(folder), basename(folder));
	}

	/** `local` as this project's id: `<key>/<local>`. */
	scope(local: string): string {
		return scopedId(this.key, local);
	}

	/** The local part of an id this project owns, or `undefined` for a bare id or another project's. */
	localOf(id: string): string | undefined {
		const parts = scopedIdParts(id);
		return parts.scope === this.key ? parts.local : undefined;
	}

	owns(id: string): boolean {
		return this.localOf(id) !== undefined;
	}

	/** The local ids among `ids` that this project owns. */
	ownedLocals(ids: Iterable<string>): ReadonlySet<string> {
		return new Set([...ids].flatMap((id) => this.localOf(id) ?? []));
	}
}

/**
 * A project's Tuval dir: its optional config module and nothing else. No state is written here and
 * none is read back from here — the desk's manifest, checkpoints and session files live under the
 * home dir, keyed by this project's absolute path (`@kampus/tuval-sdk/kernel/state-dir`, ADR 0402).
 */
export const projectDir = (project: string): string => join(project, ".tuval");
export const projectConfig = (project: string): string =>
	join(projectDir(project), "tuval.config.ts");
