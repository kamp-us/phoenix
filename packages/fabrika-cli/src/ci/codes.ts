/**
 * Exit allocations for `ci`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`; allocation checks live in `../exit-code-alignment.ts`.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;

/**
 * An input document parsed and then violated its schema: an entries JSON that is not
 * `ChangelogEntry[]`, a crabbox run-summary that is not a run summary, an `--extra-checks` file
 * that is not a `Check`. The base's reading of a body whose sections are missing or out of order,
 * widened to a whole derived document exactly as `review-ui` widens it.
 */
export const MALFORMED_DOCUMENT = SHARED_BAD_SECTIONS;

export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;

export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;
