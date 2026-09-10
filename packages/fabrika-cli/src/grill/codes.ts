/**
 * Exit allocations for `grill`; caller semantics are in `./command.ts` help.
 * Shared meanings import `../exit-codes.ts`. Code 10 stays unallocated: no verb accepts
 * a classification label, and the topic used to compose a title is not classified.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
/**
 * The text carries a machine-local path.
 *
 * **A stated widening of the base seat, which reads "…and `--redact` was not given".** No `grill`
 * verb offers `--redact`, so here the refusal fires unconditionally. The condition narrows; the
 * meaning does not drift.
 */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Proven: the session issue, the `grilling:session` label, or the issue `grill open --ticket` names,
 * does not exist.
 */
export const NO_TARGET = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/** The aligned classification seat, held empty. See the module docblock for why it is unreachable. */
export const DELIBERATE_GAP = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Proven: the **invoking token** resolves below `write` on the repository, so it may not record a
 * ruling. Distinct from {@link PRECONDITION_UNKNOWN}, which is a permission read that failed —
 * authority is never granted by a lookup that did not complete.
 */
export const TOKEN_UNAUTHORIZED = 12;
export const QUESTION_UNKNOWN = 13;
/**
 * Proven: the round holding the question could not be digested, so a binding to its text is UNKNOWN.
 *
 * Reachable while {@link QUESTION_UNKNOWN} is not: a round comment whose headings parse names its
 * questions, and a question block missing a required field still leaves nothing to digest.
 */
export const DIGEST_UNBINDABLE = 14;
export const AUTHORIZATION_ABSENT = 15;
export const SESSION_AMBIGUOUS = 16;
/**
 * Proven: the question's kind does not admit this verb.
 *
 * Deliberately not {@link BAD_SECTIONS}: answering a decision, or ruling a fact, is not a defect in
 * the input *document* — the finding or the authorization may be perfectly well-formed. Overloading
 * an imported constant with a second meaning is the drift the import exists to stop.
 */
export const KIND_MISMATCH = 17;
export const QUESTION_RETIRED = 18;
/**
 * Proven: a session's `## Came from` section is present and does not conform, so which ticket that
 * session is bound to is undecidable.
 *
 * Deliberately not {@link PRECONDITION_UNKNOWN}, whose remedy is "re-run": re-running reads the same
 * drifted bytes forever. The remedy here is a human fixing the section on the session this refusal
 * names, so it is a proven fact about an artifact rather than a read that did not complete.
 */
export const BINDING_MALFORMED = 19;
