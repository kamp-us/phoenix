/**
 * The third set of the allocation union: the ids claimed on a branch that has no pull request yet.
 *
 * The merged set and the in-flight set between them see an id only once it is on the base ref or
 * once a pull request publishes it. An epic run is neither shape for the whole life of a phase: a
 * child builds in its own worktree on a local `build/*` branch, opens no pull request, and folds
 * into an `epic/*` assembly branch at the tail. So every child's mint was invisible to every
 * sibling, two parallel children were each told the same id was free, and both minted a record at
 * it — twice on one epic, and nothing downstream caught either one until a human read both build
 * reports in the same pass.
 *
 * This read closes that. Worktrees of one clone share `refs/heads`, so the moment a sibling commits
 * its record the id is in this set, and `max(union) + 1` cannot hand it out again. The walk covers
 * remote-tracking refs as well, so a branch pushed from another clone counts here once this one has
 * fetched it; a branch still unpushed elsewhere is the residual, and it is invisible until its pull
 * request opens.
 *
 * **Why not the other two candidates the report offered.**
 *
 * - *Judge the corpus when the assembly merge happens.* That is the first tree holding both halves,
 *   so it catches the collision — but only after both children are built, reviewed and graded, which
 *   is the round the rename then has to unpick. It also answers nothing for two lanes that never
 *   share an assembly branch. Worth having as a backstop, and it is not a substitute for not minting
 *   the duplicate in the first place.
 * - *Reserve the id at mint time somewhere a sibling can read.* A reservation needs a store, an
 *   expiry and a way to release one a dead lane left behind. The commit on the branch is already
 *   that record, already shared across the clone's worktrees, and already expires the only way that
 *   matters — the branch goes away with the lane.
 *
 * **It is a claim set, never a corpus.** A branch may carry anything under the record directory, so
 * a name this cannot read an id from is skipped rather than refused: `index.md` on a long-abandoned
 * branch is not a malformed record, and refusing on it would make the live repo unmintable. The
 * strict reading stays where the corpus of record is, on the base ref.
 *
 * **An unreadable set is UNKNOWN, on the in-flight half's precedent.** A caller that reads a failed
 * ref walk as "nothing claimed" falls straight back to the collision this read exists to remove.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8901
 */
import {Effect} from "effect";
import {pathsOffBase, type Shell} from "../io/git.ts";
import {claimedIdOf} from "../io/github.ts";

/** One id a branch ref claims: the record it names, and the path it was read from. */
export interface BranchClaim {
	readonly id: string;
	readonly file: string;
}

export type BranchClaimsOutcome =
	| {readonly _tag: "Ok"; readonly value: ReadonlyArray<BranchClaim>}
	| {readonly _tag: "Err"; readonly reason: string};

/**
 * Every record id claimed on a branch ref this clone carries — local or remote-tracking — that
 * `baseSha` does not.
 *
 * Purely additive to the union: an id here is one no merged record and no open pull request holds,
 * so the answer can only move the allocation up. That direction costs a gap, which this group
 * already rules cheaper than a reused id.
 */
export const loadBranchClaims = (baseSha: string, dir: string): Shell<BranchClaimsOutcome> =>
	Effect.gen(function* () {
		const paths = yield* pathsOffBase(baseSha, dir);
		if (paths._tag === "Failure") return {_tag: "Err", reason: paths.reason};
		const claims = new Map<string, BranchClaim>();
		for (const path of paths.value) {
			const hit = claimedIdOf(path, dir);
			if (hit !== null) claims.set(hit.id, {id: hit.id, file: hit.file});
		}
		return {_tag: "Ok", value: [...claims.values()]};
	});
