/**
 * The one exit table all eight `map` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/wayfinding/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed**: an aligning group imports the base's
 * constant, so a drift is unrepresentable rather than merely detectable. This group shares eight
 * seats over `3`-`9` and `11`, and adds `12`-`21` for facts about a map — its body guard, its
 * frontier tickets, their edges, their lanes, and the two never-graduating refusals.
 *
 * Seat `10` is the one seat this group deliberately leaves empty. The base's `10` fires when a title
 * or label carries a type or priority classification; no `map` verb accepts a label flag, none writes
 * a classification label, and `map open` and `map ticket` compose their titles without classifying
 * them — so the condition is unreachable rather than merely unused, and a second meaning seated here
 * would collide with the base for no gain.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** The aligned classification seat, held empty — no `map` verb runs that check at all. */
export const DELIBERATE_GAP = REPORT_CLASSIFIED;

/** Stdin was read and held nothing. `map open` only — no other verb reads fd 0. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** A required section is missing, out of order, or holds an unparseable entry. */
export const BAD_SECTIONS = REPORT_BAD_SECTIONS;
/** The text carries a machine-local path. No `map` verb offers `--redact`, so this is unconditional. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/** Proven: the map issue, or the label a map is found by, does not exist. */
export const NO_TARGET = REPORT_NO_TARGET;
/** The write itself failed, so the outcome is **UNKNOWN** — deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed and the read-back differs. The artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A precondition read failed, so nothing was written and no outcome is proven. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Proven: the body moved since `--digest` was taken, so the write is refused.
 *
 * Its own seat rather than `9`: nothing was written here, where `9` means a write landed wrong.
 */
export const DIGEST_STALE = 12;
/** Proven: the number names no frontier ticket of this map. */
export const TICKET_UNKNOWN = 13;
/** Proven: an edge target is not a ticket of this map, or the edge would close a cycle. */
export const EDGE_UNRESOLVABLE = 14;
/** Proven: the supplied nonce does not hold this ticket's lane. */
export const LANE_NOT_MINE = 15;
/** Proven: more than one open map matches the destination — which one is undecidable. */
export const MAP_AMBIGUOUS = 16;
/**
 * Proven: no supplied line is stated as a question, so the destination carries no open question.
 *
 * Deliberately not {@link BAD_SECTIONS}: `4` says *fix the text*, this says *file it in intake
 * instead*, and overloading an imported constant with a second meaning is the drift the import
 * exists to stop.
 */
export const NOT_FOG = 17;
/** Proven: the ticket already left the frontier — graduated or retired. */
export const TICKET_RETIRED = 18;
/** Proven: the destination or direction is already recorded out of scope. */
export const ALREADY_DESCOPED = 19;
/** Proven: the ticket's kind does not admit this verb. */
export const KIND_MISMATCH = 20;
/** Proven: the lane returned no answer, so there is nothing to record. */
export const OUTCOME_UNRECORDABLE = 21;
