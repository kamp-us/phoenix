/**
 * `main-sync` pure core — decide how the orchestrator should sync the shared
 * primary checkout to `origin/main`, auto-reattaching a detached HEAD first
 * (issue #1573, Unit C of the #1494 diagnosis). IO-free and total: every decision
 * is a deterministic transform over already-gathered git facts. The git boundary
 * (branch probe / dirty probe / fetch / checkout / merge) lives in `command.ts`;
 * this module never runs a command.
 *
 * The problem it codifies (#1494 root cause): the hand-run orchestrator main-sync —
 * `git fetch origin main && git merge --ff-only origin/main` on the primary checkout —
 * lives only in operator memory. During a heavy parallel drain a primary-sharing
 * process can detach that primary HEAD onto a non-`main` commit, and the next
 * `merge --ff-only` then fails with "Not possible to fast-forward", silently wedging
 * sync until a human runs `git checkout main && git merge --ff-only origin/main` by
 * hand. This core encodes that recovery as a decision so the orchestrator runs it
 * before/after a drain instead of a human noticing.
 *
 * The safety property (the whole point, #1494 AC #3): a reattach `git checkout main`
 * is a HEAD-moving op, so it must never run when it could lose work. The #1494
 * incidents all had a CLEAN tree — so a reattach is authorized ONLY on a clean tree;
 * a dirty primary tree DETECTS-AND-SURFACES (refuse to reattach, report the dirt)
 * rather than blindly `checkout`-ing and discarding the operator's changes.
 *
 * A SECOND, gentler policy lives beside the drain-sync above: `decideMainRefresh`, the
 * post-merge refresh (#2056). Under the merge queue (ADR 0132) a PR lands GitHub-side with
 * no local `git merge` on the primary, so the owner's checkout silently drifts behind
 * `origin/main` and any read of the local tree (next-free ADR number, "does X exist yet")
 * is made against stale state. The refresh is invoked by a pipeline step that KNOWS a merge
 * landed (ship-it / the orchestrator) and passively fast-forwards the primary — but, unlike
 * the drain-sync, it NEVER moves HEAD: on a non-`main` branch or a tree with tracked
 * modifications it LEAVES THE CHECKOUT ALONE and exits cleanly (a stale checkout is no worse
 * than today; yanking the owner off their feature branch or clobbering their tracked work is).
 * It ff's through untracked-only dirt, which a fast-forward never touches (see
 * `decideMainRefresh`, #2455). Failing-to-refresh is acceptable; failing-loudly or clobbering is not.
 */

/**
 * The primary checkout's HEAD state, reduced to exactly the facts the decision needs.
 * Gathered at the git boundary (`command.ts`); both fields fail-safe toward refusing
 * to mutate — an indeterminate branch probe reads detached, an indeterminate status
 * probe reads dirty.
 */
export interface HeadState {
	/**
	 * The short branch name the primary HEAD points at, or `null` for a detached HEAD
	 * (`git rev-parse --abbrev-ref HEAD` resolved to the literal `HEAD`, or the probe
	 * was indeterminate). `"main"` is the healthy state; any other branch or `null`
	 * needs attention.
	 */
	readonly branch: string | null;
	/**
	 * The working tree has uncommitted/untracked changes (`git status --porcelain`
	 * non-empty, or the probe was indeterminate). A dirty tree blocks a reattach —
	 * a `git checkout main` from a detached HEAD with local changes could lose them.
	 * This is the coarse dirty signal the drain-sync reattach consults; the post-merge
	 * refresh consults the finer `hasTrackedModifications` instead (see #2455).
	 */
	readonly isDirty: boolean;
	/**
	 * The tree has TRACKED modifications — staged or unstaged changes to tracked files
	 * (`git status --porcelain -uno` non-empty, or the probe was indeterminate),
	 * EXCLUDING untracked files. This is the only dirt a `merge --ff-only` could clobber;
	 * git fast-forwards straight through untracked files without touching them. The
	 * post-merge refresh gates on THIS, not `isDirty`, so an untracked-only tree ff's
	 * through (see #2455). Implies `isDirty` (tracked dirt is a subset of all dirt).
	 */
	readonly hasTrackedModifications: boolean;
}

/** The name of the branch the primary checkout must be attached to for a clean main-sync. */
export const MAIN_BRANCH = "main";

/**
 * What the orchestrator should do to bring the primary checkout to a state where
 * `git merge --ff-only origin/main` can run. The order of the checks below IS the
 * safety policy.
 */
export type MainSyncPlan =
	/**
	 * HEAD is already on `main` — no reattach needed. The orchestrator proceeds
	 * straight to `fetch` + `merge --ff-only`. This is the healthy steady state.
	 */
	| {readonly action: "already-on-main"; readonly branch: string}
	/**
	 * HEAD is detached (or on a non-`main` branch) AND the tree is clean — the #1494
	 * recoverable case. A reattach `git checkout main` is authorized; the
	 * orchestrator runs it, then `fetch` + `merge --ff-only`.
	 */
	| {readonly action: "reattach"; readonly from: string}
	/**
	 * HEAD needs reattaching BUT the tree is dirty — DETECT-AND-SURFACE. A reattach
	 * here could discard the operator's uncommitted work, so the tool refuses to
	 * `checkout` and surfaces the dirt for a human, consistent with the #1494
	 * incidents (which were always clean). The orchestrator must NOT force it.
	 */
	| {readonly action: "blocked-dirty"; readonly from: string};

/**
 * A `null` branch (detached HEAD) renders as this stable label in a plan's `from`
 * field, so the report reads "reattach from detached-HEAD" rather than an empty string.
 */
export const DETACHED_LABEL = "detached-HEAD";

const fromLabel = (branch: string | null): string => branch ?? DETACHED_LABEL;

/**
 * Decide the main-sync plan from the primary checkout's HEAD state:
 *
 *   1. On `main` → `already-on-main`. No HEAD move needed; sync can proceed. The
 *      dirty flag is irrelevant here — `merge --ff-only` fails safe on its own if
 *      the tree conflicts, and this tool never touches a tree that is already on the
 *      right branch.
 *   2. Not on `main` AND dirty → `blocked-dirty`. Detect-and-surface: a reattach
 *      would risk the operator's uncommitted work, so refuse (never blindly discard).
 *   3. Not on `main` AND clean → `reattach`. The #1494 recoverable case: authorize
 *      `git checkout main` before the merge.
 *
 * Total over every `HeadState`; the dirty check is ONLY consulted on the off-`main`
 * path, so a clean-but-detached HEAD reattaches and a dirty-but-detached HEAD is
 * surfaced, never checked out.
 */
export const decideMainSync = (head: HeadState): MainSyncPlan => {
	if (head.branch === MAIN_BRANCH) {
		return {action: "already-on-main", branch: MAIN_BRANCH};
	}
	if (head.isDirty) {
		return {action: "blocked-dirty", from: fromLabel(head.branch)};
	}
	return {action: "reattach", from: fromLabel(head.branch)};
};

/**
 * What the post-merge refresh should do to bring the primary checkout up to
 * `origin/main` — the gentle, HEAD-preserving counterpart to `MainSyncPlan`. It has
 * exactly two outcomes because the refresh never moves HEAD (see the module docblock,
 * #2056): either a fast-forward is safe, or the checkout is left exactly as it is.
 */
export type MainRefreshPlan =
	/**
	 * HEAD is on `main` AND free of tracked modifications — the state in which a `git merge
	 * --ff-only origin/main` is both possible and non-destructive (untracked-only dirt is
	 * fine; a fast-forward passes straight through it, #2455). The refresh runs
	 * `fetch` + `merge --ff-only`; ff-only never creates a merge commit and aborts on any
	 * divergence, so the worst case is a no-op, never a clobber.
	 */
	| {readonly action: "fast-forward"; readonly branch: string}
	/**
	 * The refresh is a deliberate NO-OP — HEAD is not on `main`, or the tree has tracked
	 * modifications. It exits cleanly (never an error): a fast-forward of `main` can't advance
	 * a checked-out feature branch, and tracked modifications could be clobbered, so the
	 * refresh leaves the checkout untouched. `reason` records which condition held for the
	 * report (`dirty` means tracked-modified, #2455); `branch` is the current branch (or
	 * `detached-HEAD`).
	 */
	| {
			readonly action: "leave-alone";
			readonly reason: "off-main" | "dirty";
			readonly branch: string;
	  };

/**
 * Decide the post-merge refresh plan from the primary checkout's HEAD state (#2056):
 *
 *   1. Not on `main` → `leave-alone` (reason `off-main`). The owner is on their own
 *      feature branch (or detached); a fast-forward of `main` cannot advance it, and
 *      yanking them onto `main` is exactly the disruption the refresh must avoid. No-op.
 *   2. On `main` with TRACKED modifications → `leave-alone` (reason `dirty`). A fast-forward
 *      could clobber the owner's uncommitted tracked work, and a stale-but-clobber-free
 *      checkout is acceptable — failing-to-refresh beats touching tracked work. No-op.
 *   3. On `main` AND free of tracked modifications → `fast-forward`. Safe to advance —
 *      including when the tree carries untracked-only dirt (see the untracked note below).
 *
 * The branch check precedes the tracked-dirt check on purpose — off-`main` is reported even
 * when also dirty, because the branch is the binding reason the ff can't run (it can't
 * advance a checked-out feature branch regardless of tree state). Total over every `HeadState`.
 *
 * The tracked-vs-untracked distinction (#2455): the ff-blocking guard consults
 * `hasTrackedModifications`, NOT `isDirty`. `merge --ff-only` fast-forwards straight through
 * untracked files without touching them, so untracked-only dirt buys no safety by blocking —
 * gating on `isDirty` instead pinned the primary STALE session-long (the #2453 detached-HEAD
 * corruption root cause: stale on-disk skills). This matches the drain-sync path, which never
 * consults dirt once already on `main`.
 */
export const decideMainRefresh = (head: HeadState): MainRefreshPlan => {
	if (head.branch !== MAIN_BRANCH) {
		return {action: "leave-alone", reason: "off-main", branch: fromLabel(head.branch)};
	}
	if (head.hasTrackedModifications) {
		return {action: "leave-alone", reason: "dirty", branch: MAIN_BRANCH};
	}
	return {action: "fast-forward", branch: MAIN_BRANCH};
};
