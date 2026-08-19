/**
 * Which directories are real workspace members — the scope half of every guard that judges the
 * repo's own packages.
 *
 * The load-bearing detail is what "member" means: a directory matching a declared member glob is a
 * member ONLY when it carries a `package.json`. A bare directory with none is a dead shell (a
 * consolidation leaves them behind — a stale `.turbo/` log and nothing else), and a guard that
 * counted one would red on litter instead of on a real gap.
 *
 * The scope is grounded in `pnpm-workspace.yaml`'s declared globs rather than in a hardcoded
 * `"packages"` literal, so a guard tracks a workspace reshape instead of scanning a phantom
 * directory. {@link MemberScan.declared} is returned alongside the members precisely so a guard can
 * assert the glob it cares about is still declared — which is a different failure from finding no
 * members under it, and the two want different reports.
 *
 * `pnpmWorkspaceGlobs` is reused from `../delegate/root.ts` rather than re-parsed here: the
 * delegation already had to read this file, and a second parser is a second answer.
 */

import {Effect, type FileSystem, Path} from "effect";
import {pnpmWorkspaceGlobs} from "../delegate/root.ts";
import {exists, isDirectory, type ReadFailed, readDir, readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";

/** One real workspace member: a directory under a declared glob that carries a `package.json`. */
export interface WorkspaceMember {
	/** Repo-relative, forward-slashed — `packages/fabrika-cli`. */
	readonly dir: string;
	/** The declared member glob it was found under. */
	readonly glob: string;
	/**
	 * The manifest's `name` — turbo's per-task line prefix, which is the only thing that maps a
	 * package-relative diagnostic path back to a repo-relative one (`../ci/tsc-annotate.ts`).
	 *
	 * `null` when the manifest does not parse or declares no string name. Deliberately not an
	 * error: a member is a directory with a `package.json`, and every guard above judges that fact
	 * alone — making a malformed manifest fail the *scan* would red every guard on a defect only
	 * one of them can see.
	 */
	readonly name: string | null;
}

export interface MemberScan {
	/** Every member glob `pnpm-workspace.yaml` declares, in file order. */
	readonly declared: ReadonlyArray<string>;
	/** The globs this scan actually walked — `under`, or all of `declared`. */
	readonly walked: ReadonlyArray<string>;
	/** The members found, sorted by directory. */
	readonly members: ReadonlyArray<WorkspaceMember>;
}

const MANIFEST = "package.json";
const WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * The globs a caller asked for that the workspace does not declare.
 *
 * Pure, and separate from the scan, because a guard's remedy for it is its own: `readme-guard`
 * treats an undeclared `packages/*` as a broken scope assumption and fails closed, where a guard
 * scanning several globs might legitimately walk the ones that survive.
 */
export const undeclaredGlobs = (
	declared: ReadonlyArray<string>,
	requested: ReadonlyArray<string>,
): ReadonlyArray<string> => requested.filter((glob) => !declared.includes(glob));

/** The manifest's `name`, or `null` when it does not parse or declares no string name. */
const manifestName = (
	manifest: string,
): Effect.Effect<string | null, ReadFailed, FileSystem.FileSystem> =>
	readFile(manifest).pipe(
		Effect.map((text) => {
			const parsed = parseJson(text);
			return isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : null;
		}),
	);

/** The members under one `<dir>/*` glob, or the single literal member a non-glob path names. */
const membersUnder = (
	root: string,
	glob: string,
): Effect.Effect<ReadonlyArray<WorkspaceMember>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		if (!glob.endsWith("/*")) {
			const manifest = path.join(root, glob, MANIFEST);
			if (!(yield* exists(manifest))) return [];
			return [{dir: glob, glob, name: yield* manifestName(manifest)}];
		}
		const parent = glob.slice(0, -2);
		const base = path.join(root, parent);
		if (!(yield* exists(base))) return [];
		const found: Array<WorkspaceMember> = [];
		for (const child of yield* readDir(base)) {
			const abs = path.join(base, child);
			// `stat` follows symlinks, so a symlinked member still counts; plain files never do.
			if (!(yield* isDirectory(abs))) continue;
			const manifest = path.join(abs, MANIFEST);
			if (!(yield* exists(manifest))) continue;
			found.push({dir: `${parent}/${child}`, glob, name: yield* manifestName(manifest)});
		}
		return found;
	});

/**
 * Scan `root` for its real workspace members, optionally restricted to `under`.
 *
 * A read that fails leaves on the `E` channel rather than resolving to an empty scan: an unreadable
 * `packages/` answered as "no members" is exactly the vacuous pass ADR 0092 forbids, and the caller
 * that folds the two together can never tell them apart again.
 */
export const scanWorkspaceMembers = (
	root: string,
	under?: ReadonlyArray<string>,
): Effect.Effect<MemberScan, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const declared = pnpmWorkspaceGlobs(yield* readFile(path.join(root, WORKSPACE_FILE)));
		const walked = under ?? declared;
		const members: Array<WorkspaceMember> = [];
		for (const glob of walked) members.push(...(yield* membersUnder(root, glob)));
		members.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
		return {declared, walked, members};
	});
