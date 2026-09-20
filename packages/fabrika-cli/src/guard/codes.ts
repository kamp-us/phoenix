/**
 * The one exit table every `guard` verb allocates from, so a code means one thing whichever guard
 * produced it — and so a workflow step can act on the number without knowing which guard ran.
 *
 * **The overlap with the base is imported, never restated** — the discipline `../build/codes.ts`
 * states in full: an aligning group imports the base's constant, so a drift is unrepresentable
 * rather than merely detectable.
 *
 * Each guard's `--help` describes its refusal conditions; the constants below name shared meanings.
 */

import {
	PRECONDITION_UNKNOWN as BUILD_PRECONDITION_UNKNOWN,
	ZERO_SCOPE as BUILD_ZERO_SCOPE,
} from "../build/codes.ts";

/**
 * Proven: the guard's scope resolved empty — no workspace member, no changed file, no declared
 * glob to scan under. Fail-closed, never a vacuous pass.
 */
export const ZERO_SCOPE = BUILD_ZERO_SCOPE;

/** A read the verdict rests on failed, so nothing is proven — deliberately not a clean exit. */
export const PRECONDITION_UNKNOWN = BUILD_PRECONDITION_UNKNOWN;

/** Proven: the scan ran over real scope and the rule is broken. The report names every offender. */
export const VIOLATION = 12;
