/**
 * Exit allocations for `campaign`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. A failed write must remain distinct from
 * a failed precondition read: only the former may leave a partly written file.
 */

import {
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * The roadmap file could not be read, so nothing was attempted — UNKNOWN.
 *
 * Also the seat for a located row that reads as three cells but does not edit as three: the
 * contract's trigger names the file read, and the half of the `8`/`11` split that carries the
 * operator's next move is *whether a write was attempted*, which on that arm it was not.
 */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const TABLE_UNREADABLE = 12;
/**
 * The cited comment, a team membership or the author's permission could not be read, so authority is
 * UNKNOWN and nothing was written.
 *
 * Also the seat for a `campaignAuthors` that will not decode: the contract's `22` is the
 * *roadmapFile* seat, and a set nobody could read is authority nobody could resolve — not an empty
 * set, which is `17` and a different, proven fact.
 */
export const AUTHORITY_UNKNOWN = 13;
export const NO_MARKER = 14;
export const MARKER_UNBOUND = 15;
export const AUTHOR_UNDECLARED = 16;
export const NOBODY_DECLARED = 17;
export const AMBIGUOUS_SELECTOR = 18;
export const DUPLICATE_ROW = 19;
export const ALREADY_IN_STATE = 20;
export const BELOW_WRITE_FLOOR = 21;
export const CONFIG_UNREADABLE = 22;
