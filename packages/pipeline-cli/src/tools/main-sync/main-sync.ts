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
	 */
	readonly isDirty: boolean;
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
