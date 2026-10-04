/**
 * Which standing lanes are assignable homes **in this repo** — the declared set, narrowed to the
 * labels the board actually carries.
 *
 * Two questions, deliberately joined here. `boardVocabulary.standingLanes` says which lanes this
 * repo runs, and config is its only source: nothing is shipped for it, so a repo that declares none
 * runs none. A declared lane is still a name the config asserts and the board may not carry yet, and
 * offering one whose label does not exist fails a step later, at a label write naming the label
 * rather than the real cause. So the declared set is a candidate list, never the answer — a lane is
 * offered only once the board is observed to carry its label, which is the same evidence the later
 * write depends on.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6469
 */

import {Effect, type FileSystem, type Path} from "effect";
import {boardVocabularyKey} from "../config/keys/board-vocabulary.ts";
import {type Read, readKey} from "../config/read-key.ts";

/** One standing lane: a label that is a home in its own right, and what routing to it means. */
export interface StandingLane {
	readonly label: string;
	readonly meaning: string;
}

/**
 * What every offered lane's `meaning` says.
 *
 * One constant rather than the repo's live label descriptions, so a description edit cannot change a
 * machine-channel answer. A lane is a name some repo declared, and no source here can say what
 * routing to it means, so this says exactly that instead of inventing a gloss.
 */
export const DECLARED_MEANING = "a standing lane this repo declares";

/** The lanes this repo declares, or the one refusal a reader of them prints. */
export const readStandingLanes = (
	cwd: string,
): Effect.Effect<Read<ReadonlyArray<string>>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const read = yield* readKey(cwd, boardVocabularyKey);
		return read._tag === "Refused"
			? read
			: {_tag: "Value" as const, value: read.value.standingLanes, note: read.note};
	});

/**
 * The declared lanes this board can actually accept, in declared order.
 *
 * `present` is the repo's label set. A lane the board does not carry is dropped rather than reported
 * with a caveat: this list is a menu, and a menu row nobody may order is the defect.
 */
export const offeredLanes = (
	declared: ReadonlyArray<string>,
	present: ReadonlySet<string>,
): ReadonlyArray<StandingLane> =>
	declared
		.filter((label) => present.has(label))
		.map((label) => ({label, meaning: DECLARED_MEANING}));
