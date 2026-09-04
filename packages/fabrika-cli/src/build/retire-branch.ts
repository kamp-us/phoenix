/**
 * Which of an epic child's lane branches is superseded, and what a retired branch is named.
 *
 * Pure, and split from the verb because ADR 0324's whole safety argument sits here: the survivor is
 * a branch the board **attests** to, never the one a heuristic prefers. A child's branch is never
 * pushed (ADR 0285), so a wrong pick moves the only copy of somebody's work out from under the lane
 * still building on it — which is why an unattested set supersedes nothing and refuses instead.
 *
 * Retirement is a rename out of `build/`. Nothing here deletes: after it the branch still exists,
 * still carries every commit, and is still reachable by name; what changes is that
 * `childLaneBranches` (`./lane.ts`) no longer nominates it, so `traceRange` (`../lane/prove.ts`) is
 * left with one candidate and `lane prove` locates the range instead of refusing.
 */

import {parseLaneBranch} from "./lane.ts";

const BUILD_PREFIX = "build/";

/** The namespace a retired branch moves into. Any namespace but `build/` would do; one is picked. */
export const RETIRED_PREFIX = "retired/";

/** Where `branch` goes when it is retired, or `null` when it is not in the `build/` namespace. */
export const retiredBranchName = (branch: string): string | null =>
	branch.startsWith(BUILD_PREFIX) ? RETIRED_PREFIX + branch.slice(BUILD_PREFIX.length) : null;

/**
 * The survivor and what it supersedes, or the refusal.
 *
 * `Unattested` covers both directions of the same missing fact — no candidate carries an authorized
 * marker's nonce, or several do — because the act is identical either way: rename nothing. The two
 * `why` clauses differ so an operator reads which side of it they are on.
 */
export type Supersession =
	| {
			readonly _tag: "Settled";
			readonly survivor: string;
			readonly superseded: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Unattested"; readonly why: string};

/**
 * Seat the candidates against the board's authorized claim markers.
 *
 * `sessionByNonce` is `sessionsByNonce`'s map (`./retire.ts`) — the earliest authorized marker per
 * lane nonce, which is the same holder every other ownership question resolves against. A retracted
 * claim leaves no marker, so a nonce in that map is a live lane naming the branch it cut.
 */
export const supersede = (
	issue: number,
	candidates: ReadonlyArray<string>,
	sessionByNonce: Readonly<Record<string, string>>,
): Supersession => {
	const attested = candidates.filter((branch) => {
		const lane = parseLaneBranch(branch);
		return lane !== null && sessionByNonce[lane.nonce] !== undefined;
	});
	const [survivor, ...rest] = attested;
	if (survivor === undefined) {
		return {
			_tag: "Unattested",
			why: `no authorized claim marker on #${issue} carries the lane nonce of ${candidates.join(", ")} — nothing on the board says which of them a live lane cut`,
		};
	}
	if (rest.length > 0) {
		return {
			_tag: "Unattested",
			why: `${attested.join(", ")} each carry the lane nonce of an authorized claim marker on #${issue} — two live claims name two branches, and which one supersedes the other is not derivable from the board`,
		};
	}
	return {
		_tag: "Settled",
		survivor,
		superseded: candidates.filter((branch) => branch !== survivor),
	};
};
