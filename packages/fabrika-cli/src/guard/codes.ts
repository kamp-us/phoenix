/**
 * The one exit table every `guard` verb allocates from, so a code means one thing whichever guard
 * produced it — and so a workflow step can act on the number without knowing which guard ran.
 *
 * **The overlap with the base is imported, never restated** — the discipline `../build/codes.ts`
 * states in full: an aligning group imports the base's constant, so a drift is unrepresentable
 * rather than merely detectable.
 *
 * A guard speaks three refusals and they are deliberately three numbers, not one:
 *
 * - `7` {@link ZERO_SCOPE} — the scan resolved to nothing, so a green would be vacuous (ADR 0092).
 * - `11` {@link PRECONDITION_UNKNOWN} — a read failed, so the verdict is UNKNOWN, not "clean".
 * - `12` {@link VIOLATION} — the scan ran over real scope and found the thing the guard forbids.
 *
 * CI treats all three as red, which is why the v1 guards could collapse them onto `1`.
 * A human or an agent reproducing the red cannot: "your change broke the rule" and "I could not
 * read the tree" have opposite remedies, and `1` is also what a bad flag and a failed module load
 * return (`../verb.ts`), so a proven violation seated there is unreadable as proof.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	PRECONDITION_UNKNOWN as BUILD_PRECONDITION_UNKNOWN,
	ZERO_SCOPE as BUILD_ZERO_SCOPE,
} from "../build/codes.ts";

/**
 * Proven: the guard's scope resolved empty — no workspace member, no changed file, no declared
 * glob to scan under. Fail-closed, never a vacuous pass (ADR 0092).
 */
export const ZERO_SCOPE = BUILD_ZERO_SCOPE;

/** A read the verdict rests on failed, so nothing is proven — deliberately not a clean exit. */
export const PRECONDITION_UNKNOWN = BUILD_PRECONDITION_UNKNOWN;

/** Proven: the scan ran over real scope and the rule is broken. The report names every offender. */
export const VIOLATION = 12;
