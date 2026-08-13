/**
 * The ground `build tree` proves and `branch` / `check` / `push` / `pr` re-prove: where this process
 * runs, and — where asked — that the tree there carries no uncommitted change.
 *
 * **Where that is, is not one of the facts.** Fabrika holds no opinion on linked worktree versus
 * primary checkout; isolation is the operator's call, made at spawn time (the 2026-08-13 ruling on
 * #5386). What survives is don't-make-a-mess: a `--require-clean` open refuses an unauthored hunk
 * (#2666), wherever the tree sits.
 *
 * This module reads and never repairs. Nothing here creates, cleans, locks or removes anything.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {DIRTY_TREE, PRECONDITION_UNKNOWN} from "./codes.ts";

export interface TreeState {
	/** This tree's own git dir — where a per-tree file such as `info/exclude` belongs. */
	readonly gitDir: string;
	readonly root: string;
}

/**
 * The two paths every consumer needs, or the reason they could not be read.
 *
 * `--path-format=absolute` is what makes `gitDir` usable as a path to write under: `--absolute-git-dir`
 * answers relatively in some checkouts, and a relative git dir joined onto a caller's own cwd names a
 * directory that does not exist.
 */
export const readTree: Shell<Attempt<TreeState>> = Effect.gen(function* () {
	const dirs = yield* execCapture("git", [
		"rev-parse",
		"--path-format=absolute",
		"--absolute-git-dir",
		"--show-toplevel",
	]);
	if (!dirs.ok) return fail(dirs.reason);
	const lines = dirs.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const [gitDir, root] = lines;
	if (gitDir === undefined || root === undefined) {
		return fail("`git rev-parse` exited 0 but did not name the git dir and tree root");
	}
	return ok({gitDir, root});
});

/** How many paths `git status --porcelain` reports — `0` is a clean tree. */
export const uncommittedChanges: Shell<Attempt<number>> = Effect.gen(function* () {
	const status = yield* execCapture("git", ["status", "--porcelain"]);
	if (!status.ok) return fail(status.reason);
	return ok(status.stdout.split("\n").filter((line) => line.trim() !== "").length);
});

export type Ground =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Tree"; readonly root: string};

/**
 * Assert the ground, with the invoked verb's name substituted into the contract's messages.
 *
 * A tree that cannot be read is UNKNOWN, never a verdict about the tree: outside a repository there is
 * no root to stand on, and `11` is the seat for a read that proved nothing.
 */
export const assertGround = (
	verb: string,
	requireClean: boolean,
): Effect.Effect<Ground, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const state = yield* readTree;
		if (state._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read the tree root: ${state.reason} — the ground is UNKNOWN.`,
				),
			};
		}
		if (!requireClean) return {_tag: "Tree" as const, root: state.value.root};

		const dirty = yield* uncommittedChanges;
		if (dirty._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					DIRTY_TREE,
					`${verb}: cannot read the tree's status: ${dirty.reason} — cleanliness is UNKNOWN, never clean.`,
				),
			};
		}
		if (dirty.value > 0) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					DIRTY_TREE,
					`${verb}: ${dirty.value} uncommitted change(s) at open — refusing; an unauthored hunk is not yours to keep or clean.`,
				),
			};
		}
		return {_tag: "Tree" as const, root: state.value.root};
	});
