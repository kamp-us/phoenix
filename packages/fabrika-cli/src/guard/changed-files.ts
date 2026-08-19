/**
 * What a guard scans when its scope is "the change" rather than "the tree" — and what that means on
 * each CI leg.
 *
 * Today every workflow that needs this resolves it in inline shell, and each copy re-derives the
 * same four-way branch from `github.base_ref` / `github.event.merge_group.base_sha`
 * (`.github/workflows/leak-guard.yml`, `.github/workflows/cli-invocation-guard.yml`). Those copies
 * are where the fail-open lives: a base that resolves to the empty string reaches `git fetch origin
 * ""` and the diff silently becomes "nothing changed". Here the empty case has a name and no
 * `Basis` value, so a guard cannot scan a base of nothing without noticing.
 *
 * The legs, as the workflows establish them:
 *
 * - `pull_request` — `base_ref` is the target branch; the basis is `origin/<base_ref>...HEAD`.
 * - `merge_group` — `base_ref` is EMPTY on the batched ref, so the basis is the queue's
 *   `merge_group.base_sha` (ADR 0132), which yields the files the batch adds vs `main`.
 * - `workflow_dispatch` — both are empty; a dispatch carries a ref, not a base. The dispatched ref
 *   targets the default branch, and the three-dot range resolves that to the merge-base (#5718).
 * - `push` to the default branch — there is no baseline at all, and that is deliberate: the whole
 *   tree is in scope, so a violation already on `main` keeps redding until someone clears it.
 *
 * Anything else is {@link Unresolvable} — never quietly the whole tree and never an empty diff.
 */

import {type Attempt, diffRangePaths, listTreePaths, type Shell} from "../io/git.ts";

/** What a change-scoped guard reads its file list out of. */
export type Basis =
	/** `<base>...<head>`: the files this change adds or modifies vs where it diverged. */
	| {readonly _tag: "Range"; readonly base: string}
	/** No baseline exists on this leg; the scope is every tracked path at `head`. */
	| {readonly _tag: "WholeTree"};

/** A basis, or the named reason there is none. There is no third state and no empty-string base. */
export type BasisResolution = Basis | {readonly _tag: "Unresolvable"; readonly reason: string};

/**
 * The event facts a workflow hands in. Each is exactly one GitHub context value, passed as an env
 * var by the step, because a `run:` step's environment does not carry them otherwise.
 */
export interface CiEvent {
	/** `github.event_name`. */
	readonly eventName: string | undefined;
	/** `github.base_ref` — the PR's target branch, empty everywhere else. */
	readonly baseRef: string | undefined;
	/** `github.event.merge_group.base_sha` — the commit the queue built the batch on. */
	readonly mergeGroupBaseSha: string | undefined;
	/** The branch a dispatched run diffs against, and the one a push has no baseline for. */
	readonly defaultBranch: string;
}

const present = (value: string | undefined): value is string =>
	value !== undefined && value.trim() !== "";

/**
 * The basis for this leg.
 *
 * `merge_group.base_sha` is tested for CONTENT rather than assumed from the event name, so an empty
 * one can never become a base of nothing — the ordering `leak-guard.yml` already relies on.
 */
export const resolveBasis = (event: CiEvent): BasisResolution => {
	if (present(event.baseRef)) return {_tag: "Range", base: `origin/${event.baseRef.trim()}`};
	if (present(event.mergeGroupBaseSha))
		return {_tag: "Range", base: event.mergeGroupBaseSha.trim()};
	if (event.eventName === "push") return {_tag: "WholeTree"};
	if (event.eventName === "workflow_dispatch")
		return {_tag: "Range", base: `origin/${event.defaultBranch}`};
	return {
		_tag: "Unresolvable",
		reason: `no diff basis for event "${event.eventName ?? "<unset>"}": base_ref and merge_group.base_sha are both empty, and the event is neither a push nor a dispatch — the changed-file set is UNKNOWN, never empty.`,
	};
};

/**
 * The paths in scope at `head` for a basis.
 *
 * An empty list is returned as an empty list, not as a failure: whether "this change touched none
 * of my files" is a clean pass or a zero-scope red is the guard's call, and the two guards that
 * exist today answer it differently.
 */
export const filesFor = (basis: Basis, head = "HEAD"): Shell<Attempt<ReadonlyArray<string>>> =>
	basis._tag === "WholeTree" ? listTreePaths(head) : diffRangePaths(basis.base, head);
