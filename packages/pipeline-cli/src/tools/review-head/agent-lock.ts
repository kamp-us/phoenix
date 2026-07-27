/**
 * The pid-bearing git lock `review-head materialize` stamps on its throwaway tree, and the pure
 * half of resolving WHOSE pid that is (#4004).
 *
 * A `review-head-*` tree used to be born unlocked, which cost it both halves of the presence
 * system: no git-level fence against a `worktree remove` while a reviewer was live in it, and no
 * provable owner once it was orphaned — the reclaimers read a worktree's owner off its lock reason
 * (`parseAgentLockOwner`, ADR 0191), so an unlocked tree has no owner at all.
 *
 * The pid the reason carries is the OWNING SESSION's — the reviewer that asked for the tree and
 * keeps working in it — never this CLI process's, which exits seconds after `git worktree add` and
 * would mark a live tree orphaned immediately.
 */
import type {SessionRegistryEntry} from "../../session-registry.ts";

/**
 * The lock reason, in the exact grammar `parseAgentLockOwner` accepts (`claude agent <id> (pid <N>
 * start <date>)`) — the same shape the harness writes for a build tree, so a review tree lands in
 * one presence system rather than a parallel one. The round-trip is asserted in the unit test.
 */
export const formatAgentLockReason = (args: {
	readonly pr: number;
	readonly pid: number;
	readonly startedAt: Date;
}): string =>
	`claude agent review-head-${args.pr} (pid ${args.pid} start ${args.startedAt.toISOString()})`;

/**
 * The pid of the session registered under `sessionId`, or `null` when no entry matches. Pure over
 * already-read registry entries; the caller reads `<config>/sessions/*.json` (`sessionRegistryDir`).
 * A `null` here means the lock is skipped rather than written with a pid we cannot vouch for — a
 * stale pid would read as an orphan and hand a live reviewer's tree to the reaper.
 */
export const sessionPid = (
	entries: ReadonlyArray<SessionRegistryEntry>,
	sessionId: string | undefined,
): number | null => {
	const wanted = sessionId?.trim().toLowerCase();
	if (!wanted) return null;
	for (const entry of entries) {
		if (entry.sessionId.toLowerCase() === wanted) return entry.pid;
	}
	return null;
};
