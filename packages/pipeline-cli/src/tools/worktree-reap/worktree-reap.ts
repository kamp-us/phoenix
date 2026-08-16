/**
 * `worktree-reap` pure core — classify each agent worktree (a managed build tree, or a
 * `review-head-*` throwaway review checkout) into REAP / KEEP-DIRTY / SPARE with a
 * reason, for the safe reaping of worktrees orphaned by DEAD agent sessions (issue
 * #3754). IO-free and total: every decision is a deterministic transform over
 * already-gathered facts. The git + process boundary
 * (enumerate / status / ancestry / pid-liveness / unlock+remove) lives in
 * `command.ts`; this module never runs a command and never removes anything.
 *
 * Eligibility is SESSION-PRESENCE-based, never age-based (issue #3754 AC; ADR 0191 —
 * a resource claim's liveness rides its holder's presence), and presence is read from
 * TWO independent owner signals (#3989):
 *
 *   1. **the git lock reason** — `claude agent <id> (pid <N> start <date>)`, surfaced by
 *      `git worktree list --porcelain` as the `locked <reason>` line, with that pid probed
 *      for liveness at the boundary.
 *   2. **the `kampus-owner.json` owner stamp** — the session id `hooks/create-worktree.sh`
 *      writes into the tree's git admin dir, resolved against the harness's live-session
 *      registry by `worktree-sweep`'s `owner-liveness.ts` (the shared resolution, #3943).
 *
 * **Signal 2 has NO live producer today (#4180) — two signals is what this verb IMPLEMENTS,
 * not what it OBSERVES.** The harness provisions agent worktrees on its own internal path
 * instead of invoking the `WorktreeCreate` hook that writes the stamp, so no registered tree
 * carries one (274 registered, 0 stamped at the time of writing). The consumer side below is
 * correct and covered by tests, and starts working the moment a producer fires — what is false
 * is that the second signal is *available*. So in the field this is still the one-signal,
 * lock-only gate #3989 set out to fix: only a small minority of managed trees carry a lock at
 * any moment (9 of 252 when #3989 landed), so essentially everything resolves `owner-unknown`
 * and is spared — indistinguishable from correct fail-closed behaviour, the silent-no-op class
 * (#3989, #3887). Read a `0 reapable` report as partly an absence of evidence, and do not treat
 * that inertness as fixed until #4180 lands a producer that actually fires.
 *
 * BOTH signals name the LAUNCHER — the launcher pane that provisioned the tree — never the
 * subagent occupying it: the lock pid is the pane's, the stamp is written by the hook before
 * the subagent exists, and a subagent has no session identity of its own on this platform
 * (#4001). That makes launcher death sound in exactly one direction, which is the only
 * direction this verb uses: a subagent runs inside its launcher's process, so a DEAD launcher
 * proves every tree it spawned is unoccupied. A live launcher proves nothing about occupancy
 * — and needs to prove nothing here, because this verb only ever acts on proven death (the
 * distinction from the age-based `worktree-sweep`, #2240, which must reclaim under a live
 * launcher and therefore carries the `launcher-alive` grace window this verb does not need).
 *
 * The safety property is the whole point (issue #3754 AC; MEMORY "Safe worktree
 * prune"): a worktree is reaped ONLY when its owning session is DEAD *and* the tree
 * holds nothing recoverable — no uncommitted changes AND no unpushed commits. A dirty
 * or unpushed tree is KEPT (surfaced in the report as kept-dirty), never `--force`d.
 * Every fact fails safe toward KEEP: an unprovable owner reads SPARE (never reaped), an
 * indeterminate status reads uncommitted, an unresolvable ancestry reads unpushed, a
 * pid that still resolves (incl. a reused pid) reads alive → spared. With two signals the
 * fail-safe becomes a two-key rule: ANY alive signal spares, and death must be POSITIVELY
 * proven by at least one — so conflicting signals (one alive, one dead) resolve to spare.
 * `git worktree remove` *without* `--force` is the second enforcement line in `command.ts`;
 * this core only chooses WHETHER to attempt the remove, and never escalates to a forced one.
 */
import type {OwnerLiveness} from "../worktree-sweep/owner-liveness.ts";
import {isReviewHeadWorktree} from "../worktree-sweep/worktree-sweep.ts";

/** The segment that marks a harness-managed agent worktree: `<main>/.claude/worktrees/<id>`. */
const MANAGED_SEGMENT = "/.claude/worktrees/";

/** True when the path is a managed agent worktree — never the primary checkout, never a foreign tree. */
export const isManagedAgentWorktree = (path: string): boolean =>
	path.replace(/\\/g, "/").includes(MANAGED_SEGMENT);

/**
 * The owning session parsed off a worktree's git lock reason. `pid` is the top-level
 * agent session process the harness stamped into the lock (`claude agent <id> (pid <N>
 * …)`); its liveness IS the session's presence (ADR 0191).
 */
export interface AgentLockOwner {
	readonly pid: number;
}

/**
 * Parse the owning session pid out of a worktree lock reason. Returns the owner ONLY
 * for a harness-written agent lock (`claude agent … (pid <N> …)`) — an operator's
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

/** What one owner signal says about the owning session, three-state and fail-safe toward `alive`. */
export type OwnerPresence = "alive" | "dead" | "unknown";

/**
 * Read `worktree-sweep`'s stamp+registry verdict as a reap presence. Only `"dead"` licenses a
 * removal and only `"unknown"` is genuinely no-signal; EVERY other verdict — `"alive"`,
 * `"launcher-alive"`, and any variant added later — collapses to `"alive"` ⇒ SPARE. Naming the
 * two act-permitting verdicts positively (rather than switching exhaustively over the union) is
 * what makes a future verdict fail safe by default instead of by remembering to handle it.
 */
export const presenceFromOwnerLiveness = (liveness: OwnerLiveness): OwnerPresence =>
	liveness === "dead" ? "dead" : liveness === "unknown" ? "unknown" : "alive";

/**
 * One worktree reduced to exactly the facts the decision needs. `hasUncommitted` (git status
 * dirty) and `hasUnpushed` (commits not yet landed on `origin/main`) are gathered at the git
 * boundary, both fail-safe toward KEEP: an indeterminate status reads uncommitted, an
 * unresolvable ancestry reads unpushed.
 */
export interface ReapCandidate {
	readonly path: string;
	/** Short branch name, or `null` for a detached HEAD. Reported as the freed branch on a reap. */
	readonly branch: string | null;
	/**
	 * Signal 1 — the owning session parsed off the git lock reason AND its probed liveness, or
	 * `null` when no agent owner is provable from the lock (unlocked, operator-locked, or
	 * unparseable). `alive` is the boundary's `pid`-presence probe: it reads TRUE unless the pid is
	 * provably gone (a still-resolving or reused pid fails safe toward alive → SPARE).
	 */
	readonly lockOwner: (AgentLockOwner & {readonly alive: boolean}) | null;
	/**
	 * The tree carries a lock this reaper did NOT author (an operator's `git worktree lock`). Such
	 * a pin is honored unconditionally: reclaiming requires `git worktree unlock`, and unlocking a
	 * tree a human deliberately pinned is exactly the intent this verb must not override — so it is
	 * spared even when the other signal proves its session dead.
	 */
	readonly foreignLock: boolean;
	/** Signal 2 — the `kampus-owner.json` stamp resolved against the live-session registry (#3989). */
	readonly stampPresence: OwnerPresence;
	readonly hasUncommitted: boolean;
	readonly hasUnpushed: boolean;
}

/**
 * The two owner signals folded into one presence. ANY alive signal wins (a live lane is never
 * touched), death requires POSITIVE proof from at least one signal, and everything else is
 * `"unknown"` — so a tree with one alive and one dead signal reads alive, never dead.
 */
export const ownerPresence = (
	c: Pick<ReapCandidate, "lockOwner" | "foreignLock" | "stampPresence">,
): OwnerPresence => {
	if (c.foreignLock) return "unknown";
	if (c.lockOwner?.alive === true || c.stampPresence === "alive") return "alive";
	if (c.lockOwner?.alive === false || c.stampPresence === "dead") return "dead";
	return "unknown";
};

/** Why a worktree is SPARED — never a candidate this run, or its session is still live. */
export type SpareReason =
	/** Not under `.claude/worktrees/` — the primary checkout or a foreign tree; never touched. */
	| "not-managed"
	/** Neither signal proves an owner (unlocked+unstamped, or an untrustworthy registry) — can't prove orphaned. */
	| "owner-unknown"
	/** The owning session is still running per some signal — a LIVE lane; spared (the ADR 0191 presence gate). */
	| "live-session"
	/** Locked by someone other than this reaper (an operator pin) — never unlocked, never reaped. */
	| "foreign-lock";

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
 *   1. Neither a managed agent worktree nor a `review-head-*` throwaway review checkout → SPARE
 *      (`not-managed`). The primary checkout and any foreign tree are never candidates, regardless
 *      of their other facts. Review-head trees are in scope since they too carry a pid-bearing
 *      agent lock (#4004) — signal 1, the only one that resolves for that class (they are not
 *      `.claude/worktrees/` trees, so no hook ever stamps them).
 *   2. Locked by someone else → SPARE (`foreign-lock`). An operator pin outranks both owner
 *      signals, because reclaiming would mean unlocking what a human deliberately locked.
 *   3. Some signal says ALIVE → SPARE (`live-session`). The ADR 0191 presence gate, and the
 *      reason conflicting signals are safe: any alive reading beats any dead one.
 *   4. No signal proves DEATH → SPARE (`owner-unknown`). Orphanhood unprovable — never reap
 *      what we cannot prove dead. This is where the unstamped, unlocked historical pile sits.
 *   5. (Dead session) uncommitted → KEEP-DIRTY (`uncommitted`). Recoverable working-tree work.
 *   6. (Dead session, BUILD tree) unpushed → KEEP-DIRTY (`unpushed`). Committed work not on
 *      `origin/main`. Not applied to a review-head tree, whose detached head came off the remote.
 *   7. Otherwise → REAP (`orphan-clean`). Dead session, clean tree, all commits landed —
 *      nothing recoverable to strand.
 */
export const classifyCandidate = (c: ReapCandidate): ReapDecision => {
	const reviewHead = isReviewHeadWorktree(c.path);
	if (!isManagedAgentWorktree(c.path) && !reviewHead) {
		return {kind: "spare", reason: "not-managed"};
	}
	if (c.foreignLock) {
		return {kind: "spare", reason: "foreign-lock"};
	}
	const presence = ownerPresence(c);
	if (presence === "alive") {
		return {kind: "spare", reason: "live-session"};
	}
	if (presence === "unknown") {
		return {kind: "spare", reason: "owner-unknown"};
	}
	if (c.hasUncommitted) {
		return {kind: "keep-dirty", reason: "uncommitted"};
	}
	// N/A for a review-head tree: it is DETACHED at a head fetched from the remote
	// (`pull/<pr>/head`), so its HEAD is on origin by construction and "not reachable from
	// origin/main" is its normal state for an open PR, not unpushed work. Applying the build-tree
	// gate to it would keep every such orphan forever (#4004). The uncommitted gate above still runs.
	if (c.hasUnpushed && !reviewHead) {
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
