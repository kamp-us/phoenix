/**
 * The one exit table every `ci` verb allocates from.
 *
 * **The overlap with the base is imported, never restated** — the discipline `../build/codes.ts`
 * states in full: an aligning group imports the base's constant, so a drift is unrepresentable
 * rather than merely detectable.
 *
 * The group adds no code of its own. Everything a CI plumbing verb can refuse over is a read that
 * failed, a write that may not have landed, an input that parsed but is not the shape, or a pipe
 * that carried nothing — all four already named upstream.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** Nothing arrived on fd 0 — `ci pr-body` was handed no body to repair. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;

/**
 * An input document parsed and then violated its schema: an entries JSON that is not
 * `ChangelogEntry[]`, a crabbox run-summary that is not a run summary, an `--extra-checks` file
 * that is not a `Check`. The base's reading of a body whose sections are missing or out of order,
 * widened to a whole derived document exactly as `review-ui` widens it.
 */
export const MALFORMED_DOCUMENT = SHARED_BAD_SECTIONS;

/** The output file could not be written, so whether it landed is UNKNOWN. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;

/** A read the answer rests on failed — an input file, or `git rev-parse HEAD`. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;
