/**
 * The audience facet's two labels, and the writes that move an issue from one to the other.
 *
 * Who picks an issue up is a two-valued facet (#4780), and three seams act on it: `triage apply`
 * stamps it, `plan flip` moves a gated epic onto the agent side, and `decision rule` moves a ruled
 * decision there. The label strings are derived from `../config/board.ts`'s vocabulary rather than
 * typed, so a board that renames an audience renames it everywhere at once.
 *
 * **The predicates are here because the ordering they encode is a safety property.** The add lands
 * before the remove, so a half-applied flip leaves the issue carrying *both* labels rather than
 * neither — and {@link audienceSettled} then reads that as unsettled, because a caller that treated
 * "the agent label is on it" as success would report a flip that also left the human label standing.
 */

import {audienceLabel} from "../config/board.ts";

/** The one audience an agent lane may open against. */
export const READY_FOR_AGENT = audienceLabel("agent");
/** The audience that parks an issue for a person. */
export const READY_FOR_HUMAN = audienceLabel("human");
/** The prefix the facet owns, for a refusal that names an issue's audience label whatever it is. */
export const READY_FOR_PREFIX = "ready-for:";

/** The audience writes an issue is owed, read off its observed labels. */
export const audienceWrites = (
	labels: ReadonlyArray<string>,
): {readonly add: boolean; readonly remove: boolean} => ({
	add: !labels.includes(READY_FOR_AGENT),
	remove: labels.includes(READY_FOR_HUMAN),
});

/** The settled issue, decided by the read-back: pickable by agents and by nobody else. */
export const audienceSettled = (observed: ReadonlyArray<string>): boolean =>
	observed.includes(READY_FOR_AGENT) && !observed.includes(READY_FOR_HUMAN);
