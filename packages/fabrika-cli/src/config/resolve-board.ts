/**
 * One load's board vocabulary and the facet table that reconciles it — the shape every board reader
 * takes.
 *
 * Two keys answer one question, so one module joins them: `boardVocabulary` says what each facet may
 * keep, `triageFacets` says what each facet may delete. Read apart they drift into the state a
 * declared lane no facet owns is written once and never superseded (#4285), so the join runs the
 * containment invariant over the *composed* table and refuses there.
 *
 * Kept out of `./board.ts` because that module is what `../triage/facets.ts` builds the shipped
 * default from; importing the key modules there would close a cycle.
 */

import {type BoardVocabulary, composeFacets, type ResolvedBoard} from "./board.ts";
import type {FacetVocabulary} from "./containment.ts";
import {BOARD_VOCABULARY, boardVocabularyKey} from "./keys/board-vocabulary.ts";
import {triageFacetsKey} from "./keys/triage-facets.ts";
import {type Load, resolve} from "./load.ts";

export type BoardRead =
	| {readonly _tag: "Resolved"; readonly resolved: ResolvedBoard}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * The board this load runs on, or the one reason no value of it may be used.
 *
 * `Malformed` and `Unknown` both refuse: a declared value nobody could decode and a file nobody
 * could read are equally not a vocabulary, and neither may fall back to the default it did not
 * resolve to.
 */
export const resolveBoard = (load: Load, shipped: ReadonlyArray<FacetVocabulary>): BoardRead => {
	const board = resolve(load, boardVocabularyKey);
	if (board._tag === "Malformed" || board._tag === "Unknown") {
		return {_tag: "Refused", reason: board.reason};
	}
	const declared = resolve(load, triageFacetsKey);
	if (declared._tag === "Malformed" || declared._tag === "Unknown") {
		return {_tag: "Refused", reason: declared.reason};
	}
	const composed = composeFacets(
		BOARD_VOCABULARY,
		board.value,
		shipped,
		declared._tag === "Declared" ? declared.value : null,
	);
	return composed._tag === "Refused"
		? composed
		: {_tag: "Resolved", resolved: {board: board.value, facets: composed.facets}};
};

export type {BoardVocabulary, ResolvedBoard};
