/**
 * Exit allocations for `glossary`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; allocation checks live in `../exit-code-alignment.ts`.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/**
 * The register was read and a structure this verb needs — its term table, or its headings — is
 * unusable.
 *
 * A register with **no** term table at all is zero rows, never this: absence is `bootstrap` and an
 * empty table is the verb's zero-row behaviour. Only a table that exists and is malformed lands here.
 */
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
/**
 * Held empty. Machine-local paths in a register are decided by the merge-blocking leak gate over
 * changed markdown, and a second answer here could report clean while that gate reds.
 *
 * `6` is held empty for the same reason — dead internal links belong to the repo-wide link gate — and
 * carries no export at all, because `../exit-code-alignment.ts` matches this one exact name and a
 * second export of it would not compile while a renamed one would read as an allocation.
 */
export const DELIBERATE_GAP = 5;
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * A closed-enum flag carried an off-enum value — `--register` outside its vocabulary, or `both` where
 * a verb writes and a term has exactly one register.
 *
 * A semantic refusal on a *value*; a malformed *flag* stays `1`, which is the parser's.
 */
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const TERM_COLLISION = 12;
export const SECTION_ABSENT = 13;
export const ROW_SHAPE_INVALID = 14;
export const EDIT_BEYOND_ROW = 15;
