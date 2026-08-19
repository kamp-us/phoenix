/**
 * The pre-write mergeability read both landing verbs run, with its indefinite-value handling.
 *
 * `mergeable` is computed lazily by GitHub, so a `null` / `unknown` read is routine and is **not an
 * answer**: it is re-read, and a still-indefinite value is UNKNOWN and refuses. The three outcomes
 * are kept apart at the type layer because folding `Indefinite` into either neighbour is the whole
 * defect — read as `Definite` it becomes a green nobody computed, read as `Unreadable` it loses the
 * fact that the platform answered and simply had not finished.
 *
 * It lives here rather than in `ship enqueue`, which had it first, because `ship merge` asserts the
 * same precondition and a second copy of a poll loop is a second poll policy that can drift.
 */
import {Effect} from "effect";
import type {Attempt, Shell} from "../io/git.ts";
import {isIndefinite, type Mergeability, readMergeability} from "./github.ts";

/** How many extra reads the indefinite value gets before it is called UNKNOWN. */
export const MERGEABILITY_POLLS = 3;

/** How long to wait between those reads, giving GitHub's background computation time to land. */
export const MERGEABILITY_CADENCE_SECONDS = 2;

export type MergeabilityRead =
	| {readonly _tag: "Definite"; readonly value: Mergeability}
	| {readonly _tag: "Indefinite"; readonly polls: number}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const definiteOf = (attempt: Attempt<Mergeability>): MergeabilityRead =>
	attempt._tag === "Failure"
		? {_tag: "Unreadable", reason: attempt.reason}
		: isIndefinite(attempt.value)
			? {_tag: "Indefinite", polls: MERGEABILITY_POLLS}
			: {_tag: "Definite", value: attempt.value};

export const readDefiniteMergeability = (repo: string, pr: number): Shell<MergeabilityRead> =>
	Effect.gen(function* () {
		let attempt = yield* readMergeability(repo, pr);
		for (let poll = 1; poll <= MERGEABILITY_POLLS; poll++) {
			if (attempt._tag === "Failure" || !isIndefinite(attempt.value)) break;
			yield* Effect.sleep(`${MERGEABILITY_CADENCE_SECONDS} seconds`);
			attempt = yield* readMergeability(repo, pr);
		}
		return definiteOf(attempt);
	});
