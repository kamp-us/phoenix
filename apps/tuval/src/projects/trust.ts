/**
 * Which folders the person at the desk has trusted, and what opening a folder needs before anything
 * from it runs (#9693, ruling #9668 R2.1, the VS Code workspace trust model). A folder's config
 * module is code, and importing it runs it, so the decision is made before that import. There is
 * no restricted mode: a folder is trusted, or nothing from it runs.
 *
 * Trust is remembered per folder path, under the same ADR 0402 key the folder's state directory and
 * scoped ids use (`../project-id.ts`), so two spellings of one folder are trusted together. The home
 * `.tuval` config and the desk's own layer never reach this: they are read at boot, not opened.
 */

import {resolve} from "node:path";
import {Schema} from "effect";
import {ProjectId} from "../project-id.ts";

/**
 * What opening a folder needs before its config module is imported. `nothing-to-run` is a folder
 * with no `.tuval` config: no code of its own, so nothing to consent to.
 */
export type TrustGate = "nothing-to-run" | "trusted" | "ask";

/** The person answered no, or dismissed the question. Nothing from the folder was imported or run. */
export class FolderNotTrusted extends Schema.TaggedError<FolderNotTrusted>()(
	"tuval/FolderNotTrusted",
	{folder: Schema.String},
) {
	override get message(): string {
		return `the folder ${this.folder} was not trusted, so nothing from it runs`;
	}
}

const keyOf = (folder: string): string => ProjectId.of(resolve(folder)).key;

/** The folders trusted so far, in the order they were trusted. */
export class TrustedFolders {
	static readonly none = new TrustedFolders([]);

	/** Each trusted folder as it was trusted: absolute, with no trailing separator. */
	readonly folders: ReadonlyArray<string>;
	private readonly keys: ReadonlySet<string>;

	private constructor(folders: ReadonlyArray<string>) {
		this.folders = folders;
		this.keys = new Set(folders.map(keyOf));
	}

	/** The folders a saved record lists, a folder listed twice under two spellings counted once. */
	static of(folders: Iterable<string>): TrustedFolders {
		return [...folders].reduce((trusted, folder) => trusted.trust(folder), TrustedFolders.none);
	}

	trusts(folder: string): boolean {
		return this.keys.has(keyOf(folder));
	}

	trust(folder: string): TrustedFolders {
		if (this.trusts(folder)) return this;
		return new TrustedFolders([...this.folders, resolve(folder)]);
	}

	/** What opening `folder` needs, given whether it holds a `.tuval` config. */
	gate(folder: string, hasConfig: boolean): TrustGate {
		if (!hasConfig) return "nothing-to-run";
		return this.trusts(folder) ? "trusted" : "ask";
	}
}
