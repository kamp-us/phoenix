/**
 * `worktree-sweep` pure core — classify each managed agent worktree under
 * `.claude/worktrees/` into KEEP or REMOVE with a reason, for the operator's
 * sanctioned bulk drain (issue #1243). IO-free and total: every decision is a
 * deterministic transform over already-gathered facts. The git boundary
 * (enumerate / status / ancestry / remove) lives in `command.ts`; this module
 * never runs a command and never removes anything.
 *
 * The safety property is the whole point (MEMORY "Safe worktree prune", #1243 AC):
 * a worktree is removable ONLY when it is clean AND its branch's content has already
 * landed on `origin/main` — either ancestor-reachable (`reachableFromOriginMain`: a
 * non-squash merge, or detached at a merged commit) OR squash-merged
 * (`squashMergedToOriginMain`: phoenix merges by squash per ADR 0048, which rewrites
 * the branch's commits into one new commit, so the tip is NOT a commit-ancestor even
 * though its content is in `origin/main` — #1328). A dirty tree or a genuinely
 * unmerged branch is KEPT — never `--force`-removed — so unpushed work (e.g. a sibling
 * agent's live PR branch) is never silently discarded. `git worktree remove` *without*
 * `--force` is the second enforcement line in `command.ts`; this core only chooses
 * WHETHER to attempt the remove, and never escalates to a forced one.
 *
 * Liveness guard (#2240 FAIL): clean-AND-merged is NOT sufficient to remove. On the
 * SessionStart cadence, sibling agents run concurrently and a LIVE lane is routinely
 * momentarily clean-and-on-main — right after it commits+pushes, or once its PR
 * squash-merges to `origin/main` while it finishes a repair round. `git worktree remove`
 * WITHOUT `--force` does NOT protect that case: it refuses only dirty/locked/current
 * trees, not a clean tree a *sibling* process holds as its CWD (the no-`--force` line is
 * a dirty-work guard, orthogonal to liveness). So a clean+merged tree is removed only
 * when it is also provably NOT in use: unlocked AND idle past a threshold (mtime) AND
 * with no open PR for its branch. Every liveness signal fails safe toward KEEP.
 */

/** The segment that marks a harness-managed agent worktree: `<main>/.claude/worktrees/<id>`. */
const MANAGED_SEGMENT = "/.claude/worktrees/";

/** True when the path is a managed agent worktree — never the primary checkout, never a foreign tree. */
export const isManagedWorktree = (path: string): boolean =>
	path.replace(/\\/g, "/").includes(MANAGED_SEGMENT);

/**
 * One worktree reduced to exactly the facts the decision needs. `branch` is the
 * short branch name, or `null` for a detached HEAD. `isDirty`,
 * `reachableFromOriginMain`, and `squashMergedToOriginMain` are gathered at the git
 * boundary (`command.ts`), all three fail-safe toward KEEP: an indeterminate status
 * reads dirty, an unresolvable ancestry reads not-reachable, an undeterminable
 * content-equivalence reads not-squash-merged.
 */
export interface WorktreeRecord {
	readonly path: string;
	readonly branch: string | null;
	readonly isDirty: boolean;
	/** HEAD is a commit-ancestor of `origin/main` (non-squash merge, or detached at a merged commit). */
	readonly reachableFromOriginMain: boolean;
	/**
	 * The branch's cumulative diff is patch-equivalent to content already on
	 * `origin/main` even though its tip is NOT an ancestor — the squash-merge case
	 * `reachableFromOriginMain` misses (ADR 0048, #1328).
	 */
	readonly squashMergedToOriginMain: boolean;
	/**
	 * The three liveness facts (#2240) — each fail-safe toward KEEP, gathered at the git
	 * boundary. `locked`: `git worktree lock` was set (an operator/agent pinned it).
	 * `recentlyActive`: the worktree was touched within the idle threshold (an unresolvable
	 * mtime reads active). `hasOpenPr`: the branch has an open PR on the GitHub origin (a
	 * failed/indeterminate query on a GitHub origin reads true). A clean+merged tree is
	 * removed only when all three are false.
	 */
	readonly locked: boolean;
	readonly recentlyActive: boolean;
	readonly hasOpenPr: boolean;
}

/** Why a worktree is KEPT — the audit trail, so the plan is never an opaque list. */
export type KeepReason =
	/** Not under `.claude/worktrees/` — the primary checkout or a foreign tree; never touched. */
	| "not-managed"
	/** Uncommitted/untracked changes present — keep, never `--force` (unpushed work is sacred). */
	| "dirty"
	/** `git worktree lock` is set — an operator/agent pinned it as in-use (#2240). */
	| "locked"
	/** Touched within the idle threshold — presumed a live lane, never swept (#2240). */
	| "recently-active"
	/** The branch has an open PR — an in-flight lane, kept until it merges + goes idle (#2240). */
	| "open-pr"
	/** Branch not merged into `origin/main` (or detached HEAD not reachable) — live/unmerged work. */
	| "unmerged";

/** Why a worktree is REMOVABLE — clean AND its content already on `origin/main`. */
export type RemoveReason =
	/** Clean, on a branch whose tip is reachable from `origin/main` (merged). */
	| "merged-clean"
	/** Clean, detached at a commit reachable from `origin/main`. */
	| "detached-reachable"
	/** Clean; tip not an ancestor, but the branch's content squash-merged to `origin/main` (#1328). */
	| "squash-merged-clean";

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
 *   2. Dirty → KEEP (`dirty`). Wins over every merge signal: a worktree with
 *      working-tree changes is never removed, even when its branch has merged.
 *   3. Liveness gates (#2240) — locked / recently-active / open-PR → KEEP. A clean+merged
 *      tree may still belong to a LIVE sibling lane (just committed+pushed, or PR just
 *      squash-merged mid-repair). These gates run BEFORE the remove branches, so each is a
 *      necessary condition on REMOVE: a tree is swept only when it clears all three.
 *   4. Ancestor-reachable from `origin/main` → REMOVE. `merged-clean` on a branch,
 *      `detached-reachable` when detached at a merged commit. Ancestry wins over the
 *      squash signal (a non-squash merge is the simpler, stronger fact).
 *   5. Else squash-merged to `origin/main` → REMOVE (`squash-merged-clean`). The
 *      #1328 case: a squash merge (ADR 0048) leaves the tip un-ancestored but lands
 *      the branch's content, so the worktree is done.
 *   6. Otherwise → KEEP (`unmerged`). Genuinely unmerged work.
 */
export const classifyWorktree = (wt: WorktreeRecord): SweepDecision => {
	if (!isManagedWorktree(wt.path)) {
		return {kind: "keep", reason: "not-managed"};
	}
	if (wt.isDirty) {
		return {kind: "keep", reason: "dirty"};
	}
	if (wt.locked) {
		return {kind: "keep", reason: "locked"};
	}
	if (wt.recentlyActive) {
		return {kind: "keep", reason: "recently-active"};
	}
	if (wt.hasOpenPr) {
		return {kind: "keep", reason: "open-pr"};
	}
	if (wt.reachableFromOriginMain) {
		return wt.branch === null
			? {kind: "remove", reason: "detached-reachable"}
			: {kind: "remove", reason: "merged-clean"};
	}
	if (wt.squashMergedToOriginMain) {
		return {kind: "remove", reason: "squash-merged-clean"};
	}
	return {kind: "keep", reason: "unmerged"};
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
