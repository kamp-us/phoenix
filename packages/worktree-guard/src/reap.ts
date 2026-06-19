/**
 * `@kampus/worktree-guard` reap-decision core — pure decision for the
 * `SubagentStop` reaper that reclaims leaked agent worktrees (issue #741).
 *
 * The load-bearing safety rule (MEMORY "Safe worktree prune", and #741's AC): a
 * dirty/unpushed worktree must NEVER be force-removed. So this core maps a
 * finished worktree's clean/dirty status to a `git worktree remove` WITHOUT
 * `--force`: a CLEAN tree → `reap` (remove succeeds), a DIRTY tree → `refuse`
 * (the un-forced remove errors and the tree is KEPT, never silently discarded).
 *
 * `git worktree remove` (no `--force`) IS the enforcement: it refuses on a dirty
 * tree by design. The bin runs exactly that command, so even a misclassification
 * here can never discard unpushed work — the safety lives in the command, and the
 * decision here only chooses WHETHER to attempt it (and never adds `--force`).
 */

export type ReapDecision =
	| {readonly kind: "skip"; readonly reason: string}
	| {readonly kind: "reap"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** True when the path is a managed agent worktree (`<main>/.claude/worktrees/<id>`). */
export const isManagedWorktree = (worktreeRoot: string): boolean =>
	worktreeRoot.replace(/\\/g, "/").indexOf(WORKTREE_SEGMENT) > 0;

/**
 * Decide whether to reap a finished subagent's worktree.
 *
 * - Empty root, or a root NOT under the managed `.claude/worktrees/` layout →
 *   **skip** (never reap an arbitrary path; the reaper only touches its own dir).
 * - A **dirty** tree → **refuse**: keep it, never `--force` (unpushed work is sacred).
 * - A **clean** tree → **reap**: `git worktree remove` (no `--force`) reclaims it.
 */
export const decideReap = (args: {
	readonly worktreeRoot: string;
	readonly isDirty: boolean;
}): ReapDecision => {
	const {worktreeRoot, isDirty} = args;
	if (!worktreeRoot || !isManagedWorktree(worktreeRoot)) {
		return {kind: "skip", reason: "not a managed agent worktree; nothing to reap"};
	}
	if (isDirty) {
		return {
			kind: "refuse",
			reason: "worktree is dirty/unpushed; KEPT (never --force, per the safe-worktree-prune rule)",
		};
	}
	return {
		kind: "reap",
		reason: "worktree is clean; reclaiming via `git worktree remove` (no --force)",
	};
};
