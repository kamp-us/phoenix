/**
 * The one exit table all five `grill` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it (`claude-plugins/fabrika/skills/grilling/contract.md`).
 *
 * The overlap with `report` is **re-exported, never re-typed** — the discipline `ui/codes.ts` and
 * `build/codes.ts` state in full: an aligning group imports the base's constant, so a drift is
 * unrepresentable rather than merely detectable. This group shares nine seats over `3`-`11` and
 * adds `12`-`18` for facts about a recorded ruling: who invoked, which question, which round text,
 * and whether an authorization was quoted.
 *
 * Seat `10` is the one seat this group deliberately leaves empty. The base seats it for a title or
 * label carrying a type or priority classification; no `grill` verb accepts a label flag, none
 * writes one, and `grill open` composes its title from `--topic` without classifying it — so the
 * condition is unreachable rather than merely unused, and an unused seat is cheaper than a second
 * meaning on a shared number.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** Stdin was read and held nothing. `grill round` only — the one verb that reads fd 0. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** A required section is missing, out of order, or empty — the round grammar, or an empty finding. */
export const BAD_SECTIONS = REPORT_BAD_SECTIONS;
/**
 * The text carries a machine-local path.
 *
 * **A stated widening of the base seat, which reads "…and `--redact` was not given".** No `grill`
 * verb offers `--redact`, so here the refusal fires unconditionally. The condition narrows; the
 * meaning does not drift.
 */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/** Proven: the session issue, or the `grilling:session` label, does not exist. */
export const NO_TARGET = REPORT_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back differs; the artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** The aligned classification seat, held empty. See the module docblock for why it is unreachable. */
export const DELIBERATE_GAP = REPORT_CLASSIFIED;
/** A precondition read failed, so nothing was written and no outcome is proven. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Proven: the **invoking token** resolves below `write` on the repository, so it may not record a
 * ruling (ADR 0055). Distinct from {@link PRECONDITION_UNKNOWN}, which is a permission read that
 * failed — authority is never granted by a lookup that did not complete.
 */
export const TOKEN_UNAUTHORIZED = 12;
/** Proven: the question id names no question in the session. */
export const QUESTION_UNKNOWN = 13;
/**
 * Proven: the round holding the question could not be digested, so a binding to its text is UNKNOWN.
 *
 * Reachable while {@link QUESTION_UNKNOWN} is not: a round comment whose headings parse names its
 * questions, and a question block missing a required field still leaves nothing to digest.
 */
export const DIGEST_UNBINDABLE = 14;
/** Proven: `--authorization` is missing, empty, or carries no ISO-8601 date (#4938). */
export const AUTHORIZATION_ABSENT = 15;
/** Proven: more than one open session matches the topic — which one is live is undecidable. */
export const SESSION_AMBIGUOUS = 16;
/**
 * Proven: the question's kind does not admit this verb.
 *
 * Deliberately not {@link BAD_SECTIONS}: answering a decision, or ruling a fact, is not a defect in
 * the input *document* — the finding or the authorization may be perfectly well-formed. Overloading
 * an imported constant with a second meaning is the drift the import exists to stop.
 */
export const KIND_MISMATCH = 17;
/** Proven: the target question was retired by a later round, so it is not the one to record against. */
export const QUESTION_RETIRED = 18;
