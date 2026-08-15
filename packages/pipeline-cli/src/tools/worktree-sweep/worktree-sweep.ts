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
 * The surviving branch ref is what makes that unconditional prune safe — and it is also why a
 * ref is NOT reclaimed by the same decision as its tree. Ref deletion is a separate pass with a
 * separate, stricter predicate (`ref-reclaim.ts`, #4190): a tree is a replaceable container, but
 * a ref is the only thing keeping unpushed commits reachable, so a ref is deleted only on
 * positive proof its content is already on `origin/main`. Nothing in THIS module deletes a ref.
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
 *
 * Session-presence liveness (#3943): the three signals above are all the sweep had, and none of
 * them is presence — so a live SHIPPER lane read as an orphan (clean, its PR just squash-merged, and
 * mtime-idle because a ship touches no file in the tree) and had its worktree removed mid-run, twice.
 * The `locked` gate is real presence-ish signal but only partially covers the pile; see
 * `owner-liveness.ts`. Removal now additionally requires the owning session to be **provably
 * dead**: `ownerLiveness` must be `"dead"`, resolved from holder presence per ADR 0191, never from
 * age. `"alive"` and `"unknown"` both KEEP — see `owner-liveness.ts` for the resolution and for why
 * "cannot prove dead" must never collapse into "dead".
 *
 * Launcher-vs-occupant (#4001): the identity a tree is stamped with is the session that SPAWNED it,
 * never the ephemeral subagent occupying it, so a long-lived launcher pane kept every tree it ever
 * spawned `"alive"` for its whole multi-hour lifetime and the sweep went near-silent during exactly
 * the runs that generate orphans. Such an owner now resolves `"launcher-alive"` — neither presence
 * nor proof of death: the tree is held for a grace window and then decided by the ordinary
 * age/merge/open-PR gates. `owner-liveness.ts` carries why launcher liveness is only an upper
 * bound; `classifyWorktree` carries what protects a live occupant in the meantime.
 */

import type {OwnerLiveness} from "./owner-liveness.ts";

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
	/**
	 * The lock is an agent lock (`claude agent … (pid <N> …)`) whose pid is provably GONE — a
	 * stale pin, not a live claim, so it must not keep the tree. Resolved at the boundary for the
	 * `review-head-*` class only, whose locks this repo writes (`review-head materialize`, #4004); a
	 * build tree's lock stays opaque, so its keep-on-`locked` behavior is unchanged. Without this,
	 * locking review-head trees would pin every one of them forever and re-open the #2785 leak.
	 */
	readonly staleAgentLock: boolean;
	readonly recentlyActive: boolean;
	readonly hasOpenPr: boolean;
	/**
	 * Whether the agent session that OWNS this worktree is still running (#3943), resolved from
	 * holder presence at the boundary (`owner-liveness.ts`). Only `"dead"` permits a removal
	 * outright: `"alive"` is a live lane and `"unknown"` is an owner we could not prove dead — both
	 * KEEP. `"launcher-alive"` is the live-but-uninformative owner of #4001, gated by the grace
	 * window below rather than by presence.
	 */
	readonly ownerLiveness: OwnerLiveness;
	/**
	 * The tree has been untouched for longer than the launcher grace window — a far longer idle
	 * threshold than `recentlyActive`'s, consulted ONLY for a `"launcher-alive"` owner (#4001). It
	 * is what lets an orphan spawned by a still-running pane eventually become sweep-eligible while
	 * still giving a subagent the harness may have failed to lock a wide berth. Fail-safe toward
	 * KEEP: an unresolvable mtime reads `false` (within grace).
	 */
	readonly idleBeyondLauncherGrace: boolean;
}

/** Why a worktree is KEPT — the audit trail, so the plan is never an opaque list. */
export type KeepReason =
	/** Neither swept class — the primary checkout, a foreign tree, or an unrelated worktree; never touched. */
	| "not-managed"
	/** Uncommitted/untracked changes present — keep, never `--force` (unpushed work is sacred). */
	| "dirty"
	/** `git worktree lock` is set by a live/unattributable holder — pinned as in-use (#2240). */
	| "locked"
	/** The owning agent session is still running — a LIVE lane; kept whatever its other facts say (#3943). */
	| "live-session"
	/** The owning session could not be proven dead (no stamp, or an untrustworthy registry) — kept (#3943). */
	| "owner-unknown"
	/**
	 * The stamped owner is a still-running LAUNCHER, and the tree is still inside the grace window
	 * (#4001). Distinct from `live-session` on purpose: this is not presence, it is a bounded
	 * benefit of the doubt for an occupant that may have outlived the harness's occupancy lock.
	 */
	| "launcher-alive"
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
	 * A `review-head-*` throwaway detached checkout that is clean + idle + not pinned by a LIVE lock
	 * (its own agent lock counts as a pin only while that session runs — #4004). No
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
 *   3. Liveness gates — locked (#2240; a STALE agent lock, its session proven dead, does not
 *      keep — #4004) / owner alive-or-unprovable (#3943) / launcher-alive within grace (#4001) /
 *      recently-active (#2240) → KEEP, for BOTH classes. A clean tree may still belong to a LIVE
 *      lane (a build tree just committed+pushed; a review still running against its head). These
 *      run BEFORE any remove branch, so each is a necessary condition on REMOVE. The presence gate
 *      subsumes the mtime one it sits above — an idle-but-live shipper is exactly what mtime could
 *      not see — and `recently-active` is retained below it because it can only ever KEEP more.
 *
 *      The `locked` gate is what makes step 3's launcher branch safe, and its position is load-
 *      bearing: the harness holds a `git worktree lock` on an agent tree for its occupant's
 *      lifetime and releases it when the occupant finishes, so a tree that gets PAST `locked` has
 *      already had its occupancy released by the harness. That is the occupant-keyed presence
 *      signal a launcher stamp cannot be (#4001) — hence a `"launcher-alive"` owner is held only
 *      for the grace window, not forever. Never reorder `locked` below the owner gates.
 *
 *      `staleAgentLock` is a carve-out INSIDE that rule, not an exception to it: the gate keeps its
 *      position, and the carve-out is scoped at the boundary to the one class the harness does NOT
 *      lock — the `$TMPDIR`-rooted `review-head-*` trees, whose lock this repo writes itself with
 *      the owning session's pid (#4004). A build tree's lock stays opaque and absolute, so the
 *      occupancy premise above is untouched; and the carve-out fires only on POSITIVE proof that
 *      the locking session's process is gone, which for that class also proves no occupant remains
 *      (a subagent runs inside its session's process).

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
	if (wt.locked && !wt.staleAgentLock) {
		return {kind: "keep", reason: "locked"};
	}
	if (wt.ownerLiveness === "alive") {
		return {kind: "keep", reason: "live-session"};
	}
	if (wt.ownerLiveness === "unknown") {
		return {kind: "keep", reason: "owner-unknown"};
	}
	if (wt.ownerLiveness === "launcher-alive" && !wt.idleBeyondLauncherGrace) {
		return {kind: "keep", reason: "launcher-alive"};
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
	/**
	 * The lock reason: `null` when the tree is NOT locked, `""` when locked with no reason, else the
	 * reason string. Kept alongside `locked` because an agent lock's reason carries the owning
	 * session's pid — the presence fact that tells a live pin from a stale one (#4004).
	 */
	readonly lockReason: string | null;
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
	let lockReason: string | null = null;
	let prunable = false;

	const flush = () => {
		if (path !== null) {
			out.push({path, head, branch, bare, locked, lockReason, prunable});
		}
		path = null;
		head = null;
		branch = null;
		bare = false;
		locked = false;
		lockReason = null;
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
		} else if (line === "locked") {
			locked = true;
			lockReason = "";
		} else if (line.startsWith("locked ")) {
			locked = true;
			lockReason = line.slice("locked ".length);
		} else if (line.startsWith("prunable")) {
			prunable = true;
		}
	}
	flush();
	return out;
};
