/**
 * Exit allocations for `map`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. Code 10 stays unallocated: no verb accepts
 * a classification label, and the titles this group composes are not classified.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** The aligned classification seat, held empty — no `map` verb runs that check at all. */
export const DELIBERATE_GAP = SHARED_CLASSIFIED;

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Proven: the body moved since `--digest` was taken, so the write is refused.
 *
 * Its own seat rather than `9`: nothing was written here, where `9` means a write landed wrong.
 */
export const DIGEST_STALE = 12;
export const TICKET_UNKNOWN = 13;
export const EDGE_UNRESOLVABLE = 14;
export const LANE_NOT_MINE = 15;
export const MAP_AMBIGUOUS = 16;
/**
 * Proven: no supplied line is stated as a question, so the destination carries no open question.
 *
 * Deliberately not {@link BAD_SECTIONS}: `4` says *fix the text*, this says *file it in intake
 * instead*, and overloading an imported constant with a second meaning is the drift the import
 * exists to stop.
 */
export const NOT_FOG = 17;
export const TICKET_RETIRED = 18;
export const ALREADY_DESCOPED = 19;
export const KIND_MISMATCH = 20;
export const OUTCOME_UNRECORDABLE = 21;
