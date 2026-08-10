/**
 * The ground `build tree` proves and `branch` / `check` / `push` / `pr` re-prove: this process is in a
 * **linked** worktree, and (where asked) that tree is clean.
 *
 * The linked-worktree test is git plumbing and nothing else. A linked worktree's per-tree git dir
 * (`.git/worktrees/<id>`) is not the shared common dir (`<primary>/.git`); in the primary checkout the
 * two are the same path. Equality therefore *proves* the primary checkout, which is the one place work
 * must never land (#3744 / #3594 / #4162 — silent commits into the shared tree). It keys on git state
 * alone because the environment lies: the variables a spawner sets can be inherited, stale, or absent
 * while the tree is real, and vice versa.
 *
 * **This module verifies and never provisions.** Nothing here creates, locks, unlocks or removes a
 * tree: the spawner owns the tree's lifecycle (the 2026-08-03 amendment on #4707), and a verifier that
 * could also repair is the self-provision path the incident record closes.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {DIRTY_TREE, NOT_A_WORKTREE} from "./codes.ts";

export interface TreeState {
	readonly gitDir: string;
	readonly commonDir: string;
	readonly root: string;
	/** `gitDir !== commonDir` — positive evidence of a linked worktree, never an env reading. */
	readonly linked: boolean;
}

/**
 * The three paths the assertions compare, or the reason they could not be read.
 *
 * `--path-format=absolute` is what makes the comparison meaningful: `--git-common-dir` answers
 * relatively from inside a linked tree, and a relative path compared against an absolute one differs
 * for the wrong reason — it would report every primary checkout as linked.
 */
export const readTree: Shell<Attempt<TreeState>> = Effect.gen(function* () {
	const dirs = yield* execCapture("git", [
		"rev-parse",
		"--path-format=absolute",
		"--absolute-git-dir",
		"--git-common-dir",
		"--show-toplevel",
	]);
	if (!dirs.ok) return fail(dirs.reason);
	const lines = dirs.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const [gitDir, commonDir, root] = lines;
	if (gitDir === undefined || commonDir === undefined || root === undefined) {
		return fail("`git rev-parse` exited 0 but did not name the git dir, common dir and tree root");
	}
	return ok({gitDir, commonDir, root, linked: gitDir !== commonDir});
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
 * Assert the ground, with the contract's messages and the invoked verb's name substituted in.
 *
 * A tree that cannot be *read* is the primary-checkout refusal too, and deliberately so: outside any
 * repository there is no linked worktree, which is exactly what `12` says.
 */
export const assertGround = (
	verb: string,
	requireClean: boolean,
): Effect.Effect<Ground, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const state = yield* readTree;
		if (state._tag === "Failure" || !state.value.linked) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					NOT_A_WORKTREE,
					`${verb}: this is the primary checkout, not a linked worktree — stop; never build here.`,
					state._tag === "Failure" ? [`${verb}: git could not be read: ${state.reason}.`] : [],
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
