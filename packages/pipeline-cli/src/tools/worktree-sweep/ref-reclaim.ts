/**
 * Ref-reclaim pure core — decide whether an agent-worktree BRANCH REF is safe to delete,
 * given already-gathered git facts (issue #4190). IO-free and total; the git boundary
 * (enumerate refs / resolve containment / delete) lives in `ref-reclaim-io.ts`.
 *
 * The gap this closes: neither `git worktree remove` nor `git worktree prune` deletes the
 * branch the tree was on, so every reclaimed agent worktree leaves its ref behind forever.
 * Both reclaimers are built on those two commands, so the `refs/heads/worktree-*` namespace
 * only ever grows (measured on the crew host at build time: 2056 such refs against 262
 * registered worktrees, 45 of them actually checked out).
 *
 * The asymmetry with a worktree reclaim, and why this predicate is NOT the reap/sweep one:
 * a worktree is a *replaceable* container, but a ref is the ONLY thing keeping unpushed
 * commits reachable — deleting it makes them garbage. Refs are cheap to delete and impossible
 * to un-delete, so the burden of proof is inverted relative to a tree: this core deletes ONLY
 * on POSITIVE evidence that the ref's content already exists elsewhere, and treats every
 * uncertain fact as KEEP. There is no age window, no "the tree is gone so the ref must be
 * garbage", and no force.
 *
 * Absence of a worktree is deliberately NOT part of the predicate, because it is not evidence
 * of anything: a live agent's tree can be torn down underneath it (#4178/#4162, observed three
 * times on three separate shipper agents), so "tree gone" does not imply "agent done". What
 * makes a deletion lossless is containment — the ref's content already being on `origin/main`
 * — which holds regardless of who is or was working in which tree. A checked-out ref is kept
 * on top of that as a second, independent line.
 */

/**
 * The ref-name prefix of the harness-created agent-worktree branches (`worktree-agent-*`,
 * `worktree-wf-*`). Scope is prefix-anchored and fail-closed on purpose: nothing outside this
 * namespace is ever a deletion candidate, so a human branch, a `main`, or a coder's
 * `<handle>/<slug>` PR branch cannot be reached by this mechanism even when it is merged.
 */
export const MANAGED_REF_PREFIX = "worktree-";

/** True when the short ref name is in the reclaimable agent-worktree namespace. */
export const isManagedWorktreeRef = (name: string): boolean => name.startsWith(MANAGED_REF_PREFIX);

/**
 * Whether the ref's content already exists on `origin/main`, as resolved at the boundary.
 * `"absent"` means BOTH probes ran and answered no; `"unknown"` means a probe could not be
 * executed or a ref could not be resolved. The two are kept distinct rather than collapsed
 * because they are different facts — one is proven-unmerged, the other is unproven-anything —
 * even though both KEEP today. Collapsing them would make an all-unreadable run indistinguishable
 * from a genuinely unmerged namespace (the silent-no-op class, ADR 0092).
 */
export type RefContainment =
	/** Tip is a commit-ancestor of `origin/main` — a merge landed it verbatim. */
	| "reachable"
	/** Tip is not an ancestor, but its cumulative diff is patch-equivalent to content on `origin/main` (squash merge, ADR 0048, #1328). */
	| "squash-merged"
	/** Both probes executed and neither matched — the content is genuinely NOT on `origin/main`. */
	| "absent"
	/** A probe could not be executed (unresolvable `origin/main`, failed git call, exhausted probe budget) — proves nothing. */
	| "unknown";

/** One ref reduced to exactly the facts the decision needs. */
export interface RefCandidate {
	/** Short ref name (`refs/heads/<x>` → `<x>`). */
	readonly name: string;
	/** The resolved tip sha, or `null` when it could not be resolved (never deletable). */
	readonly tip: string | null;
	/** Path of the registered worktree that has this ref checked out, or `null` when none does. */
	readonly checkedOutAt: string | null;
	readonly containment: RefContainment;
}

/** Why a ref is KEPT — the audit trail, so an all-keep run is never an opaque no-op. */
export type RefKeepReason =
	/** Outside the `worktree-*` namespace — a human branch or a PR branch; never a candidate. */
	| "out-of-scope"
	/** The tip could not be resolved, so containment is unknowable and the delete could not be made atomic. */
	| "tip-unresolved"
	/** A registered worktree has it checked out — a lane may be sitting on it right now. */
	| "checked-out"
	/** Containment could not be established — an unreadable probe is "unknown", and unknown is KEEP. */
	| "containment-unknown"
	/** Proven NOT on `origin/main`: the ref is the only thing keeping this work reachable. */
	| "unmerged";

/** Why a ref is DELETABLE — its content provably survives the deletion, on `origin/main`. */
export type RefDeleteReason =
	/** Tip is an ancestor of `origin/main`. */
	| "merged"
	/** Content squash-merged into `origin/main` (#1328). */
	| "squash-merged";

export type RefDecision =
	| {readonly kind: "keep"; readonly reason: RefKeepReason}
	| {readonly kind: "delete"; readonly reason: RefDeleteReason};

/**
 * Classify a single ref. The order of checks IS the safety policy, and every branch except the
 * last two ends in KEEP:
 *
 *   1. Not in the `worktree-*` namespace → KEEP (`out-of-scope`).
 *   2. Unresolvable tip → KEEP (`tip-unresolved`). Nothing can be proven about it, and the
 *      compare-and-delete at the boundary has no expected value to bind to.
 *   3. Checked out by a registered worktree → KEEP (`checked-out`), whatever its containment.
 *   4. Containment `unknown` → KEEP (`containment-unknown`). The fail-closed default.
 *   5. Containment `absent` → KEEP (`unmerged`). The case that must never be gotten wrong.
 *   6. `reachable` → DELETE (`merged`); `squash-merged` → DELETE (`squash-merged`).
 */
export const classifyRef = (c: RefCandidate): RefDecision => {
	if (!isManagedWorktreeRef(c.name)) {
		return {kind: "keep", reason: "out-of-scope"};
	}
	if (c.tip === null) {
		return {kind: "keep", reason: "tip-unresolved"};
	}
	if (c.checkedOutAt !== null) {
		return {kind: "keep", reason: "checked-out"};
	}
	if (c.containment === "unknown") {
		return {kind: "keep", reason: "containment-unknown"};
	}
	if (c.containment === "absent") {
		return {kind: "keep", reason: "unmerged"};
	}
	return {kind: "delete", reason: c.containment === "reachable" ? "merged" : "squash-merged"};
};

export interface PlannedRefDelete {
	/** A planned delete always has a resolved tip — `tip-unresolved` is a KEEP, so the narrowed type carries that guarantee to the compare-and-delete at the boundary. */
	readonly ref: RefCandidate & {readonly tip: string};
	readonly reason: RefDeleteReason;
}

export interface PlannedRefKeep {
	readonly ref: RefCandidate;
	readonly reason: RefKeepReason;
}

export interface RefReclaimPlan {
	readonly toDelete: ReadonlyArray<PlannedRefDelete>;
	readonly kept: ReadonlyArray<PlannedRefKeep>;
}

/** Fold the per-ref decisions into the deletable / kept partition (the plan). */
export const computeRefReclaimPlan = (candidates: ReadonlyArray<RefCandidate>): RefReclaimPlan => {
	const toDelete: Array<PlannedRefDelete> = [];
	const kept: Array<PlannedRefKeep> = [];
	for (const ref of candidates) {
		const decision = classifyRef(ref);
		const tip = ref.tip;
		if (decision.kind === "delete" && tip !== null) {
			toDelete.push({ref: {...ref, tip}, reason: decision.reason});
		} else if (decision.kind === "delete") {
			kept.push({ref, reason: "tip-unresolved"});
		} else {
			kept.push({ref, reason: decision.reason});
		}
	}
	return {toDelete, kept};
};

/**
 * Parse `git for-each-ref --format='%(refname:short)%09%(objectname)'` into name/tip pairs. A
 * line missing either field yields a `null` tip rather than being dropped, so a malformed entry
 * still appears in the plan as `tip-unresolved` instead of vanishing from what the run reports.
 */
export const parseRefList = (
	stdout: string,
): ReadonlyArray<{readonly name: string; readonly tip: string | null}> => {
	const out: Array<{name: string; tip: string | null}> = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const tab = line.indexOf("\t");
		if (tab === -1) {
			out.push({name: line, tip: null});
			continue;
		}
		const name = line.slice(0, tab);
		const tip = line.slice(tab + 1).trim();
		out.push({name, tip: tip === "" ? null : tip});
	}
	return out;
};
