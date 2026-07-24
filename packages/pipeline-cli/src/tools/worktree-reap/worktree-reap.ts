/**
 * `worktree-reap` pure core — classify each managed agent worktree into REAP /
 * KEEP-DIRTY / SPARE with a reason, for the safe reaping of worktrees orphaned by
 * DEAD crew sessions (issue #3754). IO-free and total: every decision is a
 * deterministic transform over already-gathered facts. The git + process boundary
 * (enumerate / status / ancestry / pid-liveness / unlock+remove) lives in
 * `command.ts`; this module never runs a command and never removes anything.
 *
 * Eligibility is SESSION-PRESENCE-based, never age-based (issue #3754 AC; ADR 0191 —
 * a resource claim's liveness rides its holder's presence). The presence signal is
 * grounded in an observable git fact: the harness locks each agent worktree with a
 * reason that embeds the owning session's process — `claude agent <id> (pid <N>
 * start <date>)` (git worktree list --porcelain surfaces it as the `locked <reason>`
 * line). That pid is the top-level crew SESSION process shared by all worktrees it
 * provisioned; when it dies the session is gone and its worktrees are orphaned. A
 * worktree is reap-eligible ONLY when that owning pid is provably not running — the
 * presence-derived liveness ADR 0191 mandates, not an mtime idle window (the
 * distinction from the age-based `worktree-sweep`, #2240).
 *
 * The safety property is the whole point (issue #3754 AC; MEMORY "Safe worktree
 * prune"): a worktree is reaped ONLY when its owning session is DEAD *and* the tree
 * holds nothing recoverable — no uncommitted changes AND no unpushed commits. A dirty
 * or unpushed tree is KEPT (surfaced in the report as kept-dirty), never `--force`d.
 * Every fact fails safe toward KEEP: an unprovable owner reads SPARE (never reaped), an
 * indeterminate status reads uncommitted, an unresolvable ancestry reads unpushed, a
 * pid that still resolves (incl. a reused pid) reads alive → spared. `git worktree
 * remove` *without* `--force` is the second enforcement line in `command.ts`; this
 * core only chooses WHETHER to attempt the remove, and never escalates to a forced one.
 */

/** The segment that marks a harness-managed agent worktree: `<main>/.claude/worktrees/<id>`. */
const MANAGED_SEGMENT = "/.claude/worktrees/";

/** True when the path is a managed agent worktree — never the primary checkout, never a foreign tree. */
export const isManagedAgentWorktree = (path: string): boolean =>
	path.replace(/\\/g, "/").includes(MANAGED_SEGMENT);

/**
 * The owning session parsed off a worktree's git lock reason. `pid` is the top-level
 * crew session process the harness stamped into the lock (`claude agent <id> (pid <N>
 * …)`); its liveness IS the session's presence (ADR 0191).
 */
export interface AgentLockOwner {
	readonly pid: number;
}

/**
 * Parse the owning session pid out of a worktree lock reason. Returns the owner ONLY
 * for a harness-written crew-agent lock (`claude agent … (pid <N> …)`) — an operator's
 * manual `git worktree lock` with a bespoke reason, an unlocked tree (`null` reason), or
 * a reason with no parseable pid all yield `null`, so a worktree whose owner cannot be
 * proven is never treated as orphaned (fail-safe SPARE). Keying on the `claude agent`
 * prefix is deliberate: it refuses to read a pid out of a lock this reaper did not author,
 * so a human-pinned worktree is left alone.
 */
export const parseAgentLockOwner = (lockReason: string | null): AgentLockOwner | null => {
	if (lockReason === null) return null;
	if (!/^claude agent\b/.test(lockReason.trim())) return null;
	const m = lockReason.match(/\bpid\s+(\d+)\b/);
	if (m === null || m[1] === undefined) return null;
	const pid = Number.parseInt(m[1], 10);
	return Number.isFinite(pid) && pid > 0 ? {pid} : null;
};

/**
 * One worktree reduced to exactly the facts the decision needs. `owner` is the parsed
 * session with its liveness already probed at the boundary (`null` when no crew-agent
 * owner is provable). `hasUncommitted` (git status dirty) and `hasUnpushed` (commits not
 * yet landed on `origin/main`) are gathered at the git boundary, both fail-safe toward
 * KEEP: an indeterminate status reads uncommitted, an unresolvable ancestry reads unpushed.
 */
export interface ReapCandidate {
	readonly path: string;
	/** Short branch name, or `null` for a detached HEAD. Reported as the freed branch on a reap. */
	readonly branch: string | null;
	/**
	 * The parsed owning session AND its probed liveness, or `null` when no crew-agent owner is
	 * provable from the lock (unlocked, operator-locked, or unparseable). `alive` is the boundary's
	 * `pid`-presence probe: it reads TRUE unless the pid is provably gone (a still-resolving or
	 * reused pid fails safe toward alive → SPARE).
	 */
	readonly owner: (AgentLockOwner & {readonly alive: boolean}) | null;
	readonly hasUncommitted: boolean;
	readonly hasUnpushed: boolean;
}

/** Why a worktree is SPARED — never a candidate this run, or its session is still live. */
export type SpareReason =
	/** Not under `.claude/worktrees/` — the primary checkout or a foreign tree; never touched. */
	| "not-managed"
	/** No crew-agent owner is provable from the lock (unlocked, operator-locked, unparseable) — can't prove orphaned. */
	| "owner-unknown"
	/** The owning session's process is still running — a LIVE lane; spared (the ADR 0191 presence gate). */
	| "live-session";

/** Why an orphan is KEPT despite a dead session — it holds recoverable work; never destroyed. */
export type KeepDirtyReason =
	/** Uncommitted/untracked changes present — kept, never `--force` (unpushed work is sacred). */
	| "uncommitted"
	/** Committed work not yet landed on `origin/main` — kept, never destroyed (the #3754 observed case). */
	| "unpushed";

export type ReapDecision =
	| {readonly kind: "spare"; readonly reason: SpareReason}
	| {readonly kind: "keep-dirty"; readonly reason: KeepDirtyReason}
	| {readonly kind: "reap"; readonly reason: "orphan-clean"};

/**
 * Classify a single worktree. The order of checks IS the safety policy:
 *
 *   1. Not a managed agent worktree → SPARE (`not-managed`). The primary checkout and any
 *      foreign tree are never candidates, regardless of their other facts.
 *   2. No provable crew-agent owner → SPARE (`owner-unknown`). Without a parseable owning
 *      pid the session's liveness cannot be established, so orphanhood is unprovable — never
 *      reap what we cannot prove dead.
 *   3. Owning session ALIVE → SPARE (`live-session`). The ADR 0191 presence gate: a running
 *      owner pid means a live lane; spared even when the tree is clean.
 *   4. (Dead session) uncommitted → KEEP-DIRTY (`uncommitted`). Recoverable working-tree work.
 *   5. (Dead session) unpushed → KEEP-DIRTY (`unpushed`). Committed work not on `origin/main`.
 *   6. Otherwise → REAP (`orphan-clean`). Dead session, clean tree, all commits landed —
 *      nothing recoverable to strand.
 */
export const classifyCandidate = (c: ReapCandidate): ReapDecision => {
	if (!isManagedAgentWorktree(c.path)) {
		return {kind: "spare", reason: "not-managed"};
	}
	if (c.owner === null) {
		return {kind: "spare", reason: "owner-unknown"};
	}
	if (c.owner.alive) {
		return {kind: "spare", reason: "live-session"};
	}
	if (c.hasUncommitted) {
		return {kind: "keep-dirty", reason: "uncommitted"};
	}
	if (c.hasUnpushed) {
		return {kind: "keep-dirty", reason: "unpushed"};
	}
	return {kind: "reap", reason: "orphan-clean"};
};

export interface PlannedReap {
	readonly worktree: ReapCandidate;
}

export interface PlannedKeepDirty {
	readonly worktree: ReapCandidate;
	readonly reason: KeepDirtyReason;
}

export interface PlannedSpare {
	readonly worktree: ReapCandidate;
	readonly reason: SpareReason;
}

export interface WorktreeReapPlan {
	readonly toReap: ReadonlyArray<PlannedReap>;
	readonly keptDirty: ReadonlyArray<PlannedKeepDirty>;
	readonly spared: ReadonlyArray<PlannedSpare>;
}

/** Fold the per-worktree decisions into the reap / kept-dirty / spared partition (the plan). */
export const computeWorktreeReapPlan = (
	candidates: ReadonlyArray<ReapCandidate>,
): WorktreeReapPlan => {
	const toReap: Array<PlannedReap> = [];
	const keptDirty: Array<PlannedKeepDirty> = [];
	const spared: Array<PlannedSpare> = [];
	for (const worktree of candidates) {
		const decision = classifyCandidate(worktree);
		if (decision.kind === "reap") {
			toReap.push({worktree});
		} else if (decision.kind === "keep-dirty") {
			keptDirty.push({worktree, reason: decision.reason});
		} else {
			spared.push({worktree, reason: decision.reason});
		}
	}
	return {toReap, keptDirty, spared};
};

/** One parsed `git worktree list --porcelain` block, before the IO facts are gathered. */
export interface ParsedWorktree {
	readonly path: string;
	readonly head: string | null;
	/** Short branch name (`refs/heads/<x>` → `<x>`), or `null` for a detached/bare worktree. */
	readonly branch: string | null;
	readonly bare: boolean;
	/**
	 * The lock reason: `null` when the tree is NOT locked, `""` when locked with no reason,
	 * or the reason string (`claude agent <id> (pid <N> …)` for a harness-provisioned tree).
	 * The reason — not a mere locked boolean — is what carries the owning session's pid, so it
	 * is preserved here rather than collapsed to a flag (the age-based sweep discards it).
	 */
	readonly lockReason: string | null;
}

/**
 * Parse `git worktree list --porcelain` into one record per worktree. Blocks are
 * separated by a blank line; each carries a `worktree <path>` line, then optional
 * `HEAD <sha>`, `branch refs/heads/<name>` | `detached`, `bare`, `locked [<reason>]`
 * lines. Pure — the IO that produced the text lives in `command.ts`.
 */
export const parseWorktreeList = (porcelain: string): ReadonlyArray<ParsedWorktree> => {
	const out: Array<ParsedWorktree> = [];
	let path: string | null = null;
	let head: string | null = null;
	let branch: string | null = null;
	let bare = false;
	let lockReason: string | null = null;

	const flush = () => {
		if (path !== null) {
			out.push({path, head, branch, bare, lockReason});
		}
		path = null;
		head = null;
		branch = null;
		bare = false;
		lockReason = null;
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
			lockReason = "";
		} else if (line.startsWith("locked ")) {
			lockReason = line.slice("locked ".length);
		}
	}
	flush();
	return out;
};
