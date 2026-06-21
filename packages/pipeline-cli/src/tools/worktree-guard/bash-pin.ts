/**
 * `@kampus/worktree-guard` Bash cwd-pin core — pure decision for a worktree
 * subagent's `PreToolUse` Bash hook (issue #741).
 *
 * Same hazard as path-resolve: a worktree subagent's Bash cwd resets to the MAIN
 * checkout between calls, so a command with no explicit `cd` runs against the
 * primary tree (and a `git switch`/`git checkout` mis-branches it). The fix pins
 * the command to `$WORKTREE_ROOT` by prepending `cd "$WORKTREE_ROOT" &&` when the
 * command does not already establish its own working directory.
 *
 * "Already establishes its own cwd" is read conservatively: a leading `cd ` (the
 * common explicit form) is honored as-is. We do NOT try to parse arbitrary
 * shell — over-pinning a command that already cd's elsewhere would be wrong, so a
 * leading `cd` is the one signal we trust, mirroring the worktree convention's own
 * `cd <worktree-root> && …` idiom.
 */

export type BashDecision =
	| {readonly kind: "allow"}
	| {readonly kind: "rewrite"; readonly command: string; readonly reason: string};

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** True when `$WORKTREE_ROOT` is a managed agent worktree (`<main>/.claude/worktrees/<id>`). */
const isManagedWorktree = (worktreeRoot: string): boolean =>
	worktreeRoot.replace(/\\/g, "/").indexOf(WORKTREE_SEGMENT) > 0;

/** True when the command's FIRST effective token is `cd` (it sets its own cwd). */
export const hasLeadingCd = (command: string): boolean => /^\s*cd(\s|$)/.test(command);

/**
 * Decide whether to pin a Bash command to `$WORKTREE_ROOT`.
 *
 * - No `$WORKTREE_ROOT`, or a non-managed root → **allow** (not a worktree agent).
 * - An empty/whitespace-only command → **allow** (nothing to pin).
 * - A command with a leading `cd ` → **allow** (it sets its own cwd; don't fight it).
 * - Otherwise → **rewrite** to `cd "<root>" && <command>`.
 */
export const pinBash = (args: {
	readonly worktreeRoot: string;
	readonly command: string;
}): BashDecision => {
	const {worktreeRoot, command} = args;
	if (!worktreeRoot || !isManagedWorktree(worktreeRoot)) return {kind: "allow"};
	if (command.trim() === "") return {kind: "allow"};
	if (hasLeadingCd(command)) return {kind: "allow"};

	const root = stripTrailingSlash(worktreeRoot.replace(/\\/g, "/"));
	return {
		kind: "rewrite",
		command: `cd "${root}" && ${command}`,
		reason:
			"pinned to $WORKTREE_ROOT (the worktree-agent cwd reset hazard, MEMORY: Worktree agent cwd reset)",
	};
};
