/**
 * Which standing lanes are assignable homes **in this repo** — the declared set, narrowed to the
 * labels the board actually carries.
 *
 * Two questions, deliberately joined here. `boardVocabulary.standingLanes` says which lanes this
 * repo runs, and it has a shipped default, so a repo that declares nothing still resolves to
 * phoenix's pair. That default is a claim about someone else's board: in a repo where neither label
 * exists, `triage homes` offered both anyway and a triager took one, classified the whole issue, and
 * only then hit a failed label write naming a label rather than the real cause (#6440). So the
 * declared set is a candidate list, never the answer — a lane is offered only once the board is
 * observed to carry its label, which is the same evidence the later write depends on.
 *
 * ADR 0286 rules the source is config with no shipped default; the default survives until the
 * `boardVocabulary` eviction lands (#5631/#5785), and the presence filter is what makes it harmless
 * in the meantime.
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
 * What routing to each of phoenix's own lanes means.
 *
 * Constants rather than the repo's live label descriptions, so a description edit cannot change a
 * machine-channel answer. A lane outside this map is one some repo declared, and no source here can
 * say what it means — {@link DECLARED_MEANING} says exactly that instead of inventing a gloss.
 */
const SHIPPED_MEANINGS: Readonly<Record<string, string>> = {
	"wayfinder:backlog": "fog — uncharted work upstream of any arc",
	"axis:pipeline-hardening": "the standing pipeline and reliability lane",
};

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
		.map((label) => ({label, meaning: SHIPPED_MEANINGS[label] ?? DECLARED_MEANING}));
