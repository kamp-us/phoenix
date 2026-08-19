/**
 * Where an epic run assembles, and the read that proves it is not the driver's own checkout.
 *
 * The assembly branch used to be cut with `git switch --create` in whatever tree invoked `operate`,
 * which in practice is a human's working tree: it then sat on `epic/<n>` for the whole run, tools
 * that read files there read the epic branch instead of the default one, and a second epic had no
 * checkout left to integrate in (#6163). So the branch gets a worktree of its own, one per run, and
 * every git write the assembly seat performs is proven to happen outside the main working tree
 * before it runs.
 *
 * The proof is git's own `--git-dir` / `--git-common-dir` pair, read in the tree the verb is
 * standing in: they are the same path in the main working tree and differ in every linked one. A
 * path comparison against `git worktree list` cannot serve here — the two sources disagree on
 * symlinked prefixes (`/var` vs `/private/var` on macOS), and a guard that refuses the legal path is
 * worse than none.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";

/** Where assembly worktrees live, relative to the repository's main working tree. */
export const ASSEMBLY_WORKTREES_DIR = ".claude/worktrees";

/** The assembly worktree an epic run owns, as a path under the main working tree. */
export const assemblyWorktreePath = (mainRoot: string, epic: number): string =>
	`${mainRoot.replace(/\/+$/, "")}/${ASSEMBLY_WORKTREES_DIR}/epic-${epic}`;

/** One row of `git worktree list --porcelain`: the tree and the branch it stands on. */
export interface WorktreeEntry {
	readonly path: string;
	/** The short branch name, or `null` on a detached HEAD. */
	readonly branch: string | null;
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the main working tree — that
 * ordering is git's own guarantee, and it is what makes "the primary checkout" nameable at all.
 */
export const parseWorktreeList = (stdout: string): ReadonlyArray<WorktreeEntry> =>
	stdout
		.split("\n\n")
		.map((block) => {
			const lines = block.split("\n").map((line) => line.trim());
			const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
			if (path === undefined || path === "") return null;
			const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
			return {
				path,
				branch: branch === undefined ? null : branch.replace(/^refs\/heads\//, ""),
			};
		})
		.filter((entry): entry is WorktreeEntry => entry !== null);

/**
 * This repository's working trees, with the main one named apart from the rest — the one shape in
 * which "the primary checkout" is a field rather than an index nobody proved is there.
 */
export interface WorkingTrees {
	readonly main: WorktreeEntry;
	readonly linked: ReadonlyArray<WorktreeEntry>;
}

export const splitTrees = (entries: ReadonlyArray<WorktreeEntry>): WorkingTrees | null => {
	const [main, ...linked] = entries;
	return main === undefined ? null : {main, linked};
};

/** Every working tree of this repository. */
export const worktrees: Shell<Attempt<WorkingTrees>> = Effect.gen(function* () {
	const listed = yield* execCapture("git", ["worktree", "list", "--porcelain"]);
	if (!listed.ok) return fail(listed.reason);
	const trees = splitTrees(parseWorktreeList(listed.stdout));
	return trees === null ? fail("git listed no working tree at all") : ok(trees);
});

/**
 * Is the tree this process is standing in a linked worktree rather than the main working tree?
 *
 * UNKNOWN on a read fault — never `false`, which a caller would read as "the main tree", and never
 * `true`, which would wave an assembly write through unproven.
 */
export const standingInLinkedWorktree: Shell<Attempt<boolean>> = Effect.gen(function* () {
	const read = yield* execCapture("git", [
		"rev-parse",
		"--path-format=absolute",
		"--git-dir",
		"--git-common-dir",
	]);
	if (!read.ok) return fail(read.reason);
	const lines = read.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length !== 2) {
		return fail(`git answered ${lines.length} path(s) for --git-dir/--git-common-dir, not 2`);
	}
	return ok(lines[0] !== lines[1]);
});

/** What the run's assembly branch is standing in, read off the working-tree list. */
export type AssemblySeat =
	/** A linked worktree holds `epic/<n>` — the seat the run is meant to assemble in. */
	| {readonly _tag: "Isolated"; readonly path: string; readonly expected: string}
	/** The main working tree itself is on `epic/<n>` — the conscription #6163 exists to refuse. */
	| {readonly _tag: "Conscripted"; readonly path: string; readonly expected: string}
	/** No working tree holds the branch; `expected` is where one belongs. */
	| {readonly _tag: "Absent"; readonly expected: string};

/**
 * Where `epic/<n>` is checked out, judged against the one rule that matters: not the main working
 * tree. A branch parked in some other linked worktree is still isolated — the driver chose that
 * tree, and the defect is conscription of the shared checkout, not a path that differs from the
 * default.
 */
export const assemblySeat = (trees: WorkingTrees, epic: number, branch: string): AssemblySeat => {
	const expected = assemblyWorktreePath(trees.main.path, epic);
	if (trees.main.branch === branch) {
		return {_tag: "Conscripted", path: trees.main.path, expected};
	}
	const held = trees.linked.find((entry) => entry.branch === branch);
	return held === undefined
		? {_tag: "Absent", expected}
		: {_tag: "Isolated", path: held.path, expected};
};
