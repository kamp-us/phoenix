/**
 * The one exit table all seven `status` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it
 * (`claude-plugins/fabrika/skills/front-door/contract.md`, "The shared exit taxonomy").
 *
 * Every shared seat is **imported** from `../exit-codes.ts` rather than restated as a numeral —
 * the discipline `../triage/codes.ts` and `../ui/codes.ts` state in full: an import makes a drift
 * unrepresentable where a copied number makes it merely detectable.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 *
 * **`7` and `11` are this group's load-bearing pair.** `7` is a fact about a *caller-supplied* path
 * — it was named explicitly and is not there. `11` is a *failed read*. An implicitly-resolved roster
 * holding zero skills is neither: it is `empty` at exit `0`, a fact the caller acts on.
 */

import {
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/** Stdin was read and held nothing. A read that *failed* is `1` — the content is UNKNOWN. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/** The authored content carries a machine-local path. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
/** The authored content is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** Zero scope: an **explicitly passed** `--skills-dir` is proven absent (ADR 0092). */
export const ZERO_SCOPE = SHARED_NO_TARGET;
/** The write itself failed — whether anything landed is UNKNOWN. Re-read before retrying. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed and the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** A supplied value is off its closed vocabulary — an unknown `--field`, a non-integer issue. */
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
/** A precondition read failed — nothing was written and the outcome is UNKNOWN. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Refused: the surface named is not in `status bootstrap`'s buildable-surface registry. */
export const NOT_BUILDABLE = 12;

/**
 * The aligned body-section seat, held empty: no verb here composes body sections, so the gap is
 * registered rather than silently absent.
 */
export const DELIBERATE_GAP = 4;
