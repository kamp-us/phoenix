/**
 * `worktree-sweep` pure core — classify each managed agent worktree under
 * `.claude/worktrees/` into KEEP or REMOVE with a reason, for the operator's
 * sanctioned bulk drain (issue #1243). IO-free and total: every decision is a
 * deterministic transform over already-gathered facts. The git boundary
 * (enumerate / status / ancestry / remove) lives in `command.ts`; this module
 * never runs a command and never removes anything.
 *
 * The safety property is the whole point (MEMORY "Safe worktree prune", #1243 AC):
 * a worktree is removable ONLY when it is clean AND its HEAD is already reachable
 * from `origin/main` (its branch merged, or it sits detached at a merged commit). A
 * dirty tree or an unmerged branch is KEPT — never `--force`-removed — so unpushed
 * work (e.g. a sibling agent's live PR branch) is never silently discarded. `git
 * worktree remove` *without* `--force` is the second enforcement line in
 * `command.ts`; this core only chooses WHETHER to attempt the remove, and never
 * escalates to a forced one.
 */

/** The segment that marks a harness-managed agent worktree: `<main>/.claude/worktrees/<id>`. */
const MANAGED_SEGMENT = "/.claude/worktrees/";

/** True when the path is a managed agent worktree — never the primary checkout, never a foreign tree. */
export const isManagedWorktree = (path: string): boolean =>
	path.replace(/\\/g, "/").includes(MANAGED_SEGMENT);

/**
 * One worktree reduced to exactly the facts the decision needs. `branch` is the
 * short branch name, or `null` for a detached HEAD. `isDirty` and
 * `reachableFromOriginMain` are gathered at the git boundary (`command.ts`), both
 * fail-safe toward KEEP: an indeterminate status reads dirty, an unresolvable
 * ancestry reads not-reachable.
 */
export interface WorktreeRecord {
	readonly path: string;
	readonly branch: string | null;
	readonly isDirty: boolean;
	readonly reachableFromOriginMain: boolean;
}

/** Why a worktree is KEPT — the audit trail, so the plan is never an opaque list. */
export type KeepReason =
	/** Not under `.claude/worktrees/` — the primary checkout or a foreign tree; never touched. */
	| "not-managed"
	/** Uncommitted/untracked changes present — keep, never `--force` (unpushed work is sacred). */
	| "dirty"
	/** Branch not merged into `origin/main` (or detached HEAD not reachable) — live/unmerged work. */
	| "unmerged";

/** Why a worktree is REMOVABLE — clean AND already reachable from `origin/main`. */
export type RemoveReason =
	/** Clean, on a branch whose tip is reachable from `origin/main` (merged). */
	| "merged-clean"
	/** Clean, detached at a commit reachable from `origin/main`. */
	| "detached-reachable";

export type SweepDecision =
	| {readonly kind: "keep"; readonly reason: KeepReason}
	| {readonly kind: "remove"; readonly reason: RemoveReason};

export interface PlannedRemove {
	readonly worktree: WorktreeRecord;
	readonly reason: RemoveReason;
}

export interface PlannedKeep {
	readonly worktree: WorktreeRecord;
	readonly reason: KeepReason;
}

export interface WorktreeSweepPlan {
	readonly toRemove: ReadonlyArray<PlannedRemove>;
	readonly kept: ReadonlyArray<PlannedKeep>;
}

/**
 * Classify a single worktree. The order of checks IS the safety policy:
 *
 *   1. Not a managed worktree → KEEP (`not-managed`). The primary checkout and any
 *      foreign tree are never candidates, regardless of their other facts.
 *   2. Dirty → KEEP (`dirty`). Wins over reachability: a clean-looking branch that
 *      still has working-tree changes is never removed.
 *   3. Not reachable from `origin/main` → KEEP (`unmerged`). Protects a live agent's
 *      in-flight branch (e.g. an open PR's worktree) from being swept.
 *   4. Otherwise → REMOVE. `merged-clean` when on a branch, `detached-reachable`
 *      when the HEAD is detached at a merged commit.
 */
export const classifyWorktree = (wt: WorktreeRecord): SweepDecision => {
	if (!isManagedWorktree(wt.path)) {
		return {kind: "keep", reason: "not-managed"};
	}
	if (wt.isDirty) {
		return {kind: "keep", reason: "dirty"};
	}
	if (!wt.reachableFromOriginMain) {
		return {kind: "keep", reason: "unmerged"};
	}
	return wt.branch === null
		? {kind: "remove", reason: "detached-reachable"}
		: {kind: "remove", reason: "merged-clean"};
};

/** Fold the per-worktree decisions into the removable / kept partition (the plan). */
export const computeWorktreeSweepPlan = (
	records: ReadonlyArray<WorktreeRecord>,
): WorktreeSweepPlan => {
	const toRemove: Array<PlannedRemove> = [];
	const kept: Array<PlannedKeep> = [];
	for (const worktree of records) {
		const decision = classifyWorktree(worktree);
		if (decision.kind === "remove") {
			toRemove.push({worktree, reason: decision.reason});
		} else {
			kept.push({worktree, reason: decision.reason});
		}
	}
	return {toRemove, kept};
};

/** One parsed `git worktree list --porcelain` block, before the IO facts are gathered. */
export interface ParsedWorktree {
	readonly path: string;
	readonly head: string | null;
	/** Short branch name (`refs/heads/<x>` → `<x>`), or `null` for a detached/bare worktree. */
	readonly branch: string | null;
	readonly bare: boolean;
	readonly locked: boolean;
}

/**
 * Parse `git worktree list --porcelain` into one record per worktree. Blocks are
 * separated by a blank line; each carries a `worktree <path>` line, then optional
 * `HEAD <sha>`, `branch refs/heads/<name>` | `detached`, `bare`, `locked` lines.
 * Pure — the IO that produced the text lives in `command.ts`.
 */
export const parseWorktreeList = (porcelain: string): ReadonlyArray<ParsedWorktree> => {
	const out: Array<ParsedWorktree> = [];
	let path: string | null = null;
	let head: string | null = null;
	let branch: string | null = null;
	let bare = false;
	let locked = false;

	const flush = () => {
		if (path !== null) {
			out.push({path, head, branch, bare, locked});
		}
		path = null;
		head = null;
		branch = null;
		bare = false;
		locked = false;
	};

	for (const raw of porcelain.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			// A new block may start without a preceding blank line — flush the prior one.
			flush();
			path = line.slice("worktree ".length);
		} else if (line.startsWith("HEAD ")) {
			head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line === "detached") {
			branch = null;
		} else if (line === "bare") {
			bare = true;
		} else if (line.startsWith("locked")) {
			locked = true;
		}
	}
	flush();
	return out;
};
