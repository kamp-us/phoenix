/**
 * `@kampus/worktree-guard` EnterWorktree guard core — pure decision for the
 * `PreToolUse` hook on the `EnterWorktree` tool (issue #741).
 *
 * A subagent that is ALREADY inside an isolated worktree (so `$WORKTREE_ROOT` is
 * set) must not nest a second worktree inside its own — that is the spawn-loop
 * mistake that compounds the ~26GB disk leak and re-introduces the cwd hazard one
 * level deeper. So when `$WORKTREE_ROOT` is set, `EnterWorktree` is hard-blocked;
 * when it is unset (a top-level agent), `EnterWorktree` is allowed.
 */

export type EnterDecision =
	| {readonly kind: "allow"}
	| {readonly kind: "block"; readonly reason: string};

/** Block `EnterWorktree` iff `$WORKTREE_ROOT` is already set (we're inside a worktree). */
export const guardEnterWorktree = (worktreeRoot: string | undefined): EnterDecision => {
	if (worktreeRoot && worktreeRoot.trim() !== "") {
		return {
			kind: "block",
			reason: `already inside an isolated worktree ($WORKTREE_ROOT=${worktreeRoot}); refusing to nest a second worktree (issue #741)`,
		};
	}
	return {kind: "allow"};
};
