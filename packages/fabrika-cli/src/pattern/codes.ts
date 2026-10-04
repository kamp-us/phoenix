/**
 * Exit allocations for `pattern`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; allocation checks live in `../exit-code-alignment.ts`.
 *
 * Codes 3 through 7 stay unallocated. No verb reads stdin, validates authored heading grammar,
 * composes an authored body or judges a corpus; the repo leak gate owns path checks.
 * An empty doc directory must allow a repo to write its first pattern.
 */

import {
	CLASSIFIED as SHARED_CLASSIFIED,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

export const DOC_ABSENT = 12;
export const ALREADY_EXISTS = 13;
/**
 * The edit would have changed a line beyond the one row — aborted before writing.
 *
 * The load-bearing seat of the group. `.patterns/index.md` is hand-curated, carries prose between
 * its tables, and is edited by lanes `pattern register` cannot see, so an insertion that reflowed a
 * table or rewrote a neighbouring row would destroy work with no diff small enough to notice.
 */
export const MULTI_LINE_DIFF = 14;
export const INDEX_UNPARSEABLE = 15;
/**
 * Proven: the named section matches more than one heading.
 *
 * Its own seat rather than {@link OFF_VOCABULARY}'s because the remedy differs: `10` says the flag
 * names a section that is not there, and this says the flag is right and the index needs
 * disambiguating.
 */
export const SECTION_AMBIGUOUS = 16;
export const SOURCE_REPOSITORY_REFUSED = 17;
