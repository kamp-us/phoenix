/**
 * Which git repository a checkout belongs to, and therefore whether two checkouts are one repository.
 *
 * The delegation refuses to hand an invocation to a *different* checkout (#4956). A linked working
 * tree is not one: `git worktree` gives a single repository several working trees, so the copy on
 * `PATH` sitting in the primary checkout while the cwd sits in a worktree is one project seen twice,
 * and refusing there made the bare `fabrika` unusable from every worktree (#5679).
 *
 * The identity compared is git's own `$GIT_COMMON_DIR`, read **off disk** rather than by spawning
 * `git`: this runs in the bootstrap, before any dependency is guaranteed linked and before there is
 * a runtime to carry a subprocess, which is the same constraint that makes `root.ts` hand-read
 * `pnpm-workspace.yaml`. The read follows `gitrepository-layout(5)`: a `.git` **directory** is the
 * common dir itself; a `.git` **file** holds `gitdir: <path>` naming this working tree's own git
 * dir, and that dir's `commondir` file — when present — names the common dir it shares, "relative to
 * $GIT_DIR" when the path in it is relative.
 */
import {Effect, type FileSystem, Path} from "effect";
import {exists, isDirectory, type ReadFailed, readFile, realPath} from "../io/fs.ts";
import type {SelfOrigin} from "./root.ts";

const GIT_ENTRY = ".git";
const COMMON_DIR_FILE = "commondir";
const GIT_FILE = /^gitdir:\s*(.*)$/m;

/** The git dir a `.git` file names, or `undefined` when the text is not a git file at all. */
export const gitFileTarget = (text: string): string | undefined => {
	const target = GIT_FILE.exec(text)?.[1]?.trim();
	return target === undefined || target === "" ? undefined : target;
};

/**
 * The `$GIT_COMMON_DIR` of the checkout at `root`, real-path resolved so two spellings of one
 * directory compare equal — or `undefined` when `root` is not a git working tree, or its pointer is
 * stale.
 *
 * `undefined` is never read as "same repository" by {@link relateCopy}: a checkout whose repository
 * cannot be established is treated as a different one, which is the direction that refuses rather
 * than the one that answers from a tree nobody named.
 */
export const repositoryOf = (
	root: string,
): Effect.Effect<string | undefined, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const entry = path.join(root, GIT_ENTRY);
		if (!(yield* exists(entry))) return undefined;
		if (yield* isDirectory(entry)) return yield* realPath(entry);
		const target = gitFileTarget(yield* readFile(entry));
		if (target === undefined) return undefined;
		const gitDir = path.resolve(root, target);
		const commonDirFile = path.join(gitDir, COMMON_DIR_FILE);
		const common = (yield* exists(commonDirFile))
			? path.resolve(gitDir, (yield* readFile(commonDirFile)).trim())
			: gitDir;
		return (yield* exists(common)) ? yield* realPath(common) : undefined;
	});

/**
 * Where the running copy's home stands relative to the repo the cwd is in — the single fact the
 * foreign-checkout refusal turns on.
 *
 * `other-repository` is the only state that refuses, and it carries the checkout the refusal has to
 * name. Everything else is `same-repository`, which is a claim about crossing rather than about
 * sameness: an installed copy belongs to no repository to cross out of, the cwd's own checkout is
 * not a crossing, and another working tree of one repository is the tree the caller named by
 * standing in it.
 */
export type CopyOrigin =
	| {readonly _tag: "same-repository"}
	| {readonly _tag: "other-repository"; readonly checkout: string};

/**
 * Relate the running copy's checkout to the repo root above the cwd.
 *
 * The two cheap answers come first and touch no git plumbing at all: an installed artifact, and a
 * cwd already inside the copy's own checkout. Only a genuine second tree costs two reads.
 */
export const relateCopy = (
	self: SelfOrigin,
	repoRoot: string | undefined,
): Effect.Effect<CopyOrigin, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (self._tag === "no-checkout" || repoRoot === undefined || repoRoot === self.root)
			return {_tag: "same-repository"} as const;
		const mine = yield* repositoryOf(self.root);
		const theirs = yield* repositoryOf(repoRoot);
		return mine !== undefined && mine === theirs
			? ({_tag: "same-repository"} as const)
			: ({_tag: "other-repository", checkout: self.root} as const);
	});
