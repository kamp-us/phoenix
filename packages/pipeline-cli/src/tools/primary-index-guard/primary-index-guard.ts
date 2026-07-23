/**
 * `primary-index-guard` pure core — the BLOCKING §CP promotion of the read-only
 * `@kampus/primary-index-tripwire` (PR #2783). Decides whether a commit carrying the #2778
 * mass-staged-deletion signature (a mass control-plane staged deletion) against the PRIMARY
 * checkout is REFUSED. IO-free and total: a deterministic transform over already-gathered git
 * facts; the git boundary (staged-deletion probe, primary-checkout resolution) lives in
 * `command.ts`, wired as git's own `pre-commit` hook (`lefthook.yml`).
 *
 * Why THIS choke point (the residual vector #2783 named). `ref-guard`'s `reference-transaction`
 * hook refuses only a DIVERGING `refs/heads/main` move; a commit of the mass deletion on top of
 * `origin/main` is a FAST-FORWARD (origin/main is an ancestor of the new tip), so ref-guard allows
 * it. `main-sync` catches a dirty primary only on its sanctioned path. The one caller-agnostic
 * boundary that fires as the loaded-gun commit is CREATED — before any push can fast-forward it to
 * `origin/main` — is `pre-commit`. This guard blocks there; the tripwire's read-only record leg is
 * preserved alongside (record for attribution, block for containment).
 *
 * Scoped to the PRIMARY checkout. A linked worktree's commit lands on its own feature branch behind
 * PR review, never a fast-forward to `origin/main`, so a worktree commit is ALLOWED here (the
 * tripwire still records it as the #2666 bleed class). Reuses the tripwire's `decideTripwire`
 * detection verbatim — single source of the signature, no reinvention.
 */
import {
	type AttributionRecord,
	decideTripwire,
	MASS_DELETION_BLOCK_THRESHOLD,
	renderWarning,
	type StagedEntry,
} from "./index.ts";

export {MASS_DELETION_BLOCK_THRESHOLD};

/** The git + environment facts the block decision needs, gathered read-only at the caller's boundary. */
export interface PrimaryIndexCommitInput {
	/** The commit target is the PRIMARY checkout (`git-dir == git-common-dir`). The guard blocks ONLY here. */
	readonly onPrimaryCheckout: boolean;
	readonly staged: readonly StagedEntry[];
	readonly cwd: string;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	/** Minimum control-plane staged deletions to REFUSE (default {@link MASS_DELETION_BLOCK_THRESHOLD}). */
	readonly threshold: number;
	readonly at: string;
}

export type PrimaryIndexDecision =
	| {readonly kind: "allow"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string; readonly record: AttributionRecord};

/**
 * Decide whether to REFUSE a commit carrying the #2778 signature on the PRIMARY checkout:
 *
 *   1. NOT the primary checkout → `allow`. A linked worktree's commit is contained to its own
 *      branch (PR-reviewed), so it can never fast-forward to `origin/main`; the tripwire records it.
 *   2. On the primary, staged fileset BELOW the mass threshold → `allow`. A legitimate multi-file
 *      control-plane refactor is not the corruption; only a MASS deletion trips (see the threshold).
 *   3. On the primary, staged fileset AT/above the threshold → `refuse`. The loaded-gun state: a
 *      commit + push would fast-forward a control-plane mass deletion onto `origin/main`. Fail-closed.
 *
 * Total over every input; delegates the signature classification to the tripwire core so "what is a
 * #2778 mass deletion" has exactly one definition.
 */
export const decidePrimaryIndexCommit = (input: PrimaryIndexCommitInput): PrimaryIndexDecision => {
	if (!input.onPrimaryCheckout) {
		return {
			kind: "allow",
			reason:
				"not the PRIMARY checkout (a linked worktree) — the commit lands on a feature branch behind PR review, never a fast-forward to origin/main; the read-only tripwire still records it",
		};
	}
	const decision = decideTripwire({
		onPrimaryCheckout: true,
		staged: input.staged,
		cwd: input.cwd,
		agentType: input.agentType,
		sessionId: input.sessionId,
		worktreeRoot: input.worktreeRoot,
		threshold: input.threshold,
		at: input.at,
	});
	if (decision.kind === "quiet") {
		return {kind: "allow", reason: decision.reason};
	}
	return {
		kind: "refuse",
		reason:
			`refusing a commit carrying the #2778 mass-staged-deletion signature on the PRIMARY checkout — ${renderWarning(decision.record)}. ` +
			"A commit + push here fast-forwards this control-plane mass deletion onto origin/main (ref-guard allows a fast-forward). " +
			"Recover with `git reset` (unstage; 0 commits ahead ⇒ `git reset --hard origin/main` restores tracked files, preserves untracked). " +
			"If this deletion is genuinely intended, do it on a worktree branch through a reviewed PR, never a direct primary commit.",
		record: decision.record,
	};
};
