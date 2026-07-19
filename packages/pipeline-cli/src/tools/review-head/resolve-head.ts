/**
 * The IO-free head-resolution core for `review-head` — the deterministic decision a
 * review gate makes when it materializes "the PR's current review head" for review
 * (#793 / #1807). It answers two things from the untrusted `repos/:repo/pulls/:pr`
 * REST payload, with no git or `gh` IO of its own:
 *
 *  1. `resolveHead` — WHICH head. Extract the PR's current (latest) head SHA + ref from
 *     the payload, fail-safe to `unresolvable` when there is no bindable head (a missing
 *     / closed PR, a deleted head branch, a non-40-hex sha) rather than let a gate
 *     materialize a head it cannot bind a verdict to.
 *  2. `planMaterialization` — HOW to check it out. The per-run ref + `pull/<pr>/head`
 *     refspec, and — load-bearing — that the checkout is ALWAYS **detached** onto that ref,
 *     never a `git checkout <headRef>` of the branch: §RO (gh-issue-intake-formats.md)
 *     forbids a gate switching the launched tree onto the head branch, and `pull/<pr>/head`
 *     resolves for same-repo AND cross-fork PRs so there is never a branch to switch to.
 *
 * The IO shell (`materialize.ts`) decodes the REST JSON at the boundary and drives this
 * core; keeping the decision here is what makes "latest head / detached-vs-branch /
 * missing-PR fail-safe" unit-testable without a live repo or PR.
 */

/** The head fields `review-head` reads off the decoded `repos/:repo/pulls/:pr` payload. */
export interface PullHeadPayload {
	readonly number: number;
	readonly state: string;
	/** `null` when GitHub reports no head object (a deleted head, some closed-PR shapes). */
	readonly head: {
		readonly sha: string | null;
		readonly ref: string | null;
		/** `head.repo.full_name` — `null` when the head fork was deleted. */
		readonly repoFullName: string | null;
	} | null;
	/** `base.repo.full_name` — the merge-target repo, to classify a cross-fork head. */
	readonly baseRepoFullName: string;
}

/** A resolved, bindable head — a full-40-hex SHA plus the branch name and fork classification. */
export interface ResolvedHead {
	readonly headSha: string;
	/** The head branch name; `""` when the head branch was already deleted (SHA still bindable). */
	readonly headRef: string;
	/** True when the head lives on a fork of the base repo (still fetched via `pull/<pr>/head`). */
	readonly crossFork: boolean;
}

export type HeadResolution =
	| ({readonly _tag: "resolved"} & ResolvedHead)
	| {readonly _tag: "unresolvable"; readonly reason: string};

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Resolve the PR's current review head from the REST payload. REST always returns the
 * PR's *latest* head, so `.head.sha` is the current head with no history to walk. Fail-safe:
 * a `null` head, an empty/non-40-hex SHA all resolve to `unresolvable` — a gate must not
 * materialize (and bind a verdict to) a head it cannot name (ADR 0058 §5).
 */
export const resolveHead = (pull: PullHeadPayload): HeadResolution => {
	if (pull.head === null || pull.head.sha === null) {
		return {
			_tag: "unresolvable",
			reason: `PR #${pull.number} (state=${pull.state}) has no head SHA — a missing/closed PR or a deleted head; refusing to materialize a head no verdict can bind to`,
		};
	}
	const headSha = pull.head.sha.trim().toLowerCase();
	if (!FULL_SHA_RE.test(headSha)) {
		return {
			_tag: "unresolvable",
			reason: `PR #${pull.number} head SHA '${pull.head.sha}' is not a full 40-hex commit — refusing to bind a verdict to a partial/malformed head (ADR 0058 §5)`,
		};
	}
	return {
		_tag: "resolved",
		headSha,
		headRef: pull.head.ref ?? "",
		crossFork: pull.head.repoFullName !== null && pull.head.repoFullName !== pull.baseRepoFullName,
	};
};

/** The per-run ref a gate fetches the head into — PR-namespaced AND nonce-uniqued so two concurrent reviews of the same PR never collide on the ref (#1807). */
export const perRunRef = (pr: number, nonce: string): string => `refs/pr/${pr}-${nonce}`;

/** The refspec that fetches the PR head into `prRef` — `pull/<pr>/head` resolves same-repo AND cross-fork. */
export const fetchRefspec = (pr: number, prRef: string): string => `pull/${pr}/head:${prRef}`;

/** The deterministic checkout plan `review-head materialize` executes for a resolved head. */
export interface MaterializePlan {
	readonly headSha: string;
	readonly headRef: string;
	readonly crossFork: boolean;
	/** The per-run ref the head is fetched into and (optionally) worktree-checked-out from. */
	readonly prRef: string;
	/** `pull/<pr>/head:<prRef>` — the fetch that lands the head in `prRef` without touching the working tree. */
	readonly fetchRefspec: string;
	/**
	 * ALWAYS true: the head is checked out DETACHED onto `prRef`, never `git checkout <headRef>`.
	 * §RO forbids a gate switching the launched tree onto the head branch, and a cross-fork head
	 * has no local branch to switch to — a detached per-run ref is the one shape safe for both.
	 */
	readonly detach: true;
	/** The throwaway worktree path when a full tree is materialized (`--worktree`), else `null` (ref-only). */
	readonly worktreeDir: string | null;
}

/**
 * Build the checkout plan for a resolved head. The plan is detached-only by construction
 * (`detach: true`, target `prRef`) — the "detached, never the branch" §RO decision made
 * once here rather than re-derived per gate. `worktreeDir` is set only when the caller
 * asked for a full materialized tree (the code/skill gates); a ref-only gate (review-doc)
 * leaves it `null` and reads the head via `git show "$prRef:<path>"`.
 */
export const planMaterialization = (
	head: ResolvedHead,
	opts: {readonly pr: number; readonly nonce: string; readonly worktreeDir?: string},
): MaterializePlan => {
	const prRef = perRunRef(opts.pr, opts.nonce);
	return {
		headSha: head.headSha,
		headRef: head.headRef,
		crossFork: head.crossFork,
		prRef,
		fetchRefspec: fetchRefspec(opts.pr, prRef),
		detach: true,
		worktreeDir: opts.worktreeDir ?? null,
	};
};
