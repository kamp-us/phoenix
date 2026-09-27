/**
 * Exit allocations for `table`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; unused shared codes stay unallocated.
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** Proven: the configured `table.project` number names no project under its owner. */
export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Proven: `.fabrika.jsonc`'s `table` block does not decode; nothing was read from GitHub. */
export const CONFIG_MALFORMED = 12;

/**
 * Proven: the token lacks the `project` scope. Its own seat because it has one exact fix, which the
 * refusal names, and a caller routing on it sends the operator to that command and nowhere else.
 */
export const SCOPE_MISSING = 20;

/** Proven: a field the table needs exists under its name with another type. Nothing was changed for it. */
export const SHAPE_CONFLICT = 21;

/**
 * Proven: more than one open project linked to the repository, or more than one under its owner,
 * carries the table's title.
 */
export const AMBIGUOUS_PROJECT = 22;

/**
 * Proven: the table project lacks a field or option `table sync` writes. `table setup` adds it, so
 * the refusal names that verb and nothing was written.
 */
export const NOT_SET_UP = 23;

/**
 * Proven: an issue the run touches carries a `lane-record` comment that does not read. Its spend and
 * asks are undecidable, so nothing was written.
 */
export const MALFORMED_RECORD = 24;
