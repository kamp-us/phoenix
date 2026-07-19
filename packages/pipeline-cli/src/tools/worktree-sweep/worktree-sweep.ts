/**
 * `worktree-sweep` pure core — classify each swept worktree into KEEP or REMOVE with a
 * reason, for the operator's sanctioned bulk drain (issue #1243). IO-free and total:
 * every decision is a deterministic transform over already-gathered facts. The git
 * boundary (enumerate / status / ancestry / remove) lives in `command.ts`; this module
 * never runs a command and never removes anything.
 *
 * Three swept classes (#2785, #3654):
 *   - **Build worktrees** under `.claude/worktrees/` — a harness-provisioned agent tree
 *     that carries a real branch and may hold unpushed work; removable ONLY when clean AND
 *     its branch's content already landed on `origin/main` (the merge gate below).
 *   - **Review-head worktrees** — the `$TMPDIR`-rooted `review-head-*` / `review-doc-head-*`
 *     / `review-skill-head-*` DETACHED checkouts a review gate materializes from a PR head
 *     (`isReviewHeadWorktree`). These are throwaway scratch trees of an already-pushed PR
 *     head: they carry NO branch and no unpushed work, so they need no merge gate — a clean,
 *     idle, unlocked one holds nothing recoverable. Without this class they were `not-managed`
 *     and never reaped, so they leaked unbounded (562 accumulated before a manual sweep).
 *   - **Gone-dir worktrees** (#3654) — ANY tree, managed or foreign, whose working directory
 *     is already gone (`git worktree list --porcelain` flags it `prunable`). Only the stale
 *     `.git/worktrees/<id>` admin metadata lingers; there is no on-disk tree to strand and the
 *     branch ref survives a prune, so it is reaped unconditionally via `git worktree prune`
 *     (never `git worktree remove`, whose path is missing). This is the bulk of a cross-session
 *     pile: trees that outlived the sessions whose temp roots were cleaned from under them.
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
 * The leaf-basename prefix of a `$TMPDIR`-rooted throwaway review checkout — `review-head-<PR>`
 * (review-code), `review-doc-head-<PR>` (review-doc), `review-skill-head-<PR>` (review-skill).
 * Anchored to the basename so a substring match on some parent dir can't misclassify a build tree.
 */
const REVIEW_HEAD_BASENAME = /^review-(doc-|skill-)?head-/;

/** True when the path is a throwaway detached review-head checkout (a review gate's scratch tree, #2785). */
export const isReviewHeadWorktree = (path: string): boolean => {
	const norm = path.replace(/\\/g, "/");
	return REVIEW_HEAD_BASENAME.test(norm.slice(norm.lastIndexOf("/") + 1));
};

/** True when the worktree is in scope for the sweep at all — either swept class. */
export const isSweptWorktree = (path: string): boolean =>
	isManagedWorktree(path) || isReviewHeadWorktree(path);

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
	/**
	 * The tree's working directory is already gone — `git worktree list --porcelain`
	 * flagged it `prunable` (its gitdir points at a non-existent location, #3654). Only
	 * the stale `.git/worktrees/<id>` admin metadata survives; there is no on-disk working
	 * tree to hold unpushed work, and the branch ref is untouched by a prune, so any
	 * committed work stays in the object store. Checked FIRST in `classifyWorktree` —
	 * before managed-ness or dirtiness — because it is unconditionally safe to reap.
	 */
	readonly prunable: boolean;
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
	/** Neither swept class — the primary checkout, a foreign tree, or an unrelated worktree; never touched. */
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

/** Why a worktree is REMOVABLE — a build tree clean AND on `origin/main`, or an idle review-head tree. */
export type RemoveReason =
	/**
	 * The working directory is already gone — reap the stale `.git/worktrees/<id>` metadata
	 * via `git worktree prune` (#3654). No `git worktree remove` (the path is missing); the
	 * prune only clears admin metadata and never touches a branch ref, so nothing recoverable
	 * is lost. This is the bulk of a cross-session pile: trees whose sessions' temp roots were
	 * cleaned out from under them.
	 */
	| "gone-dir"
	/** Clean, on a branch whose tip is reachable from `origin/main` (merged). */
	| "merged-clean"
	/** Clean, detached at a commit reachable from `origin/main`. */
	| "detached-reachable"
	/** Clean; tip not an ancestor, but the branch's content squash-merged to `origin/main` (#1328). */
	| "squash-merged-clean"
	/**
	 * A `review-head-*` throwaway detached checkout that is clean + unlocked + idle (#2785). No
	 * merge gate: it holds a detached, already-pushed PR head and no branch/unpushed work, so once
	 * it is clean, unlocked, and idle it is a pure leak — nothing to strand. Requiring merge here
	 * would strand it for the PR's entire open life (a review is a bounded one-shot event, not tied
	 * to PR lifetime), defeating the reclaim; the #2240 liveness triple (dirty/locked/recently-active)
	 * still guards a live review.
	 */
	| "review-head-idle";

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
 *   0. Prunable (working dir already gone) → REMOVE (`gone-dir`), regardless of managed-ness
 *      (#3654). Wins over everything, INCLUDING `not-managed`: a gone-dir tree — a foreign
 *      `scratchpad/wt-*` from a dead session as much as a managed one — has no working tree to
 *      strand and its branch ref survives the prune, so clearing the stale metadata is
 *      unconditionally safe. This is what reaps the cross-session pile of orphaned trees.
 *   1. Neither swept class → KEEP (`not-managed`). The primary checkout and any foreign
 *      tree with a LIVE directory are never candidates, regardless of their other facts.
 *   2. Dirty → KEEP (`dirty`). Wins over every other signal for BOTH classes: a worktree
 *      with working-tree changes is never removed, even when its branch has merged.
 *   3. Liveness gates (#2240) — locked / recently-active → KEEP, for BOTH classes. A clean
 *      tree may still belong to a LIVE lane (a build tree just committed+pushed; a review
 *      still running against its head). These run BEFORE any remove branch, so each is a
 *      necessary condition on REMOVE.
 *   4. Review-head tree → REMOVE (`review-head-idle`). Past the dirty+locked+recently-active
 *      guards, a detached throwaway review checkout holds no branch and no unpushed work, so
 *      it is a pure leak — no merge/open-PR gate applies (see `review-head-idle`). Returns here
 *      before the build-tree merge gates so an unmerged PR head is still reclaimed.
 *   5. (Build tree) open-PR → KEEP. A clean+merged build tree may still belong to a live sibling
 *      lane whose branch has an open PR (#2240) — an open-PR review-head tree never reaches this
 *      branch, and its detached HEAD has no branch to query anyway.
 *   6. (Build tree) ancestor-reachable from `origin/main` → REMOVE — `merged-clean` on a branch,
 *      `detached-reachable` when detached at a merged commit. Ancestry wins over the squash signal.
 *   7. (Build tree) else squash-merged to `origin/main` → REMOVE (`squash-merged-clean`). The
 *      #1328 case: a squash merge (ADR 0048) leaves the tip un-ancestored but lands the content.
 *   8. Otherwise → KEEP (`unmerged`). Genuinely unmerged work.
 */
export const classifyWorktree = (wt: WorktreeRecord): SweepDecision => {
	if (wt.prunable) {
		return {kind: "remove", reason: "gone-dir"};
	}
	const reviewHead = isReviewHeadWorktree(wt.path);
	if (!isManagedWorktree(wt.path) && !reviewHead) {
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
	if (reviewHead) {
		return {kind: "remove", reason: "review-head-idle"};
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
	/** `git worktree list --porcelain` flagged the tree `prunable` — its working dir is gone (#3654). */
	readonly prunable: boolean;
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
	let prunable = false;

	const flush = () => {
		if (path !== null) {
			out.push({path, head, branch, bare, locked, prunable});
		}
		path = null;
		head = null;
		branch = null;
		bare = false;
		locked = false;
		prunable = false;
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
		} else if (line.startsWith("prunable")) {
			prunable = true;
		}
	}
	flush();
	return out;
};
