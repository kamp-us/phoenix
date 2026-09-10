/**
 * Whether the trunk already carries a commit's content — the one containment read every caller
 * that is about to destroy or re-cut a branch asks.
 *
 * **Ancestry alone answers "no" on a squash trunk, for every branch, always.** Where a repository
 * takes every landing as a squash, a landed branch's own commits never enter the trunk and
 * `merge-base --is-ancestor` exits non-zero even when the content merged completely — so a resume
 * guard written as ancestry answers "not contained" for exactly the branches it exists to catch.
 * Ancestry stays the fast path here, and what survives it is settled by cumulative patch id.
 *
 * The patch arm is measured, not reasoned about: on one such branch the branch's own net patch id
 * and the trunk commit's path-limited one are both
 * `d18b491a48c861494a35740f571a90a45b596aae`. The pathspec is what makes those two comparable —
 * limited to the paths the branch touches, a squash commit's diff IS that branch's net diff. A
 * squash that landed over an intervening change to the same paths does not match and answers
 * `Unlanded`, which is the fail-safe direction: the caller resumes rather than destroys.
 *
 * Reads refs and objects only, never a board: a re-cut is opened by what git can prove.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	diffRange,
	diffRangePaths,
	isAncestor,
	mergeBase,
	noMergeBaseReason,
	patchIdsIn,
	patchIdsOf,
} from "./git.ts";

/**
 * What the trunk says about one commit.
 *
 * `Squashed` is the case that matters. `NoChange` is the stronger one beside it — the commit
 * diverges and its net diff against the trunk is empty, so nothing is only here whatever the graph
 * says. `Unknown` is never resolved to either polarity: a read that failed proves nothing, and the
 * caller refuses on it.
 */
export type Containment =
	| {readonly _tag: "Ancestor"}
	| {readonly _tag: "Squashed"; readonly commit: string}
	/** The commit diverges from the trunk and adds no content to it — nothing here is only here. */
	| {readonly _tag: "NoChange"}
	| {readonly _tag: "Unlanded"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * How far back along the trunk a squash is looked for.
 *
 * Bounded because the scan reads patches, not commit names. Past it the answer is `Unlanded` — the
 * fail-safe direction, and the reason a bound is allowed to exist here at all.
 */
const TRUNK_SCAN = 200;

/**
 * What `trunk` carries of `head` — a commit name or a branch name, either reads the same.
 *
 * The ancestor test runs first because it is one cheap call and settles a merge trunk outright. Only
 * what survives it pays for the patch reads.
 */
export const containmentOf = (
	head: string,
	trunk: string,
): Effect.Effect<Containment, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (head === "") return {_tag: "Unknown" as const, reason: "no HEAD commit was named"};
		if (yield* isAncestor(head, trunk)) return {_tag: "Ancestor" as const};

		const diff = yield* diffRange(trunk, head);
		if (diff._tag === "Failure") {
			return {_tag: "Unknown" as const, reason: `cannot diff it against ${trunk}: ${diff.reason}`};
		}
		if (diff.value.trim() === "") return {_tag: "NoChange" as const};

		const own = yield* patchIdsOf(diff.value);
		const mine = own._tag === "Ok" ? own.value[0] : undefined;
		if (mine === undefined) {
			return {
				_tag: "Unknown" as const,
				reason: `cannot compute the patch id of what it adds${own._tag === "Failure" ? `: ${own.reason}` : ""}`,
			};
		}

		const paths = yield* diffRangePaths(trunk, head);
		if (paths._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot list the paths it changes: ${paths.reason}`,
			};
		}
		const base = yield* mergeBase(trunk, head);
		if (base._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `it shares ${yield* noMergeBaseReason(trunk, base.reason)}`,
			};
		}
		const landed = yield* patchIdsIn(base.value, trunk, paths.value, TRUNK_SCAN);
		if (landed._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot scan ${trunk} for the patch it adds: ${landed.reason}`,
			};
		}
		const match = landed.value.find((row) => row.patch === mine.patch);
		return match === undefined
			? {_tag: "Unlanded" as const}
			: {_tag: "Squashed" as const, commit: match.commit};
	});
