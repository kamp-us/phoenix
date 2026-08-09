/**
 * The one exit table all eight `review` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * **The overlap with `report` and `triage` is re-exported, never re-typed.** Where this group's
 * codes meet the shipped writing verbs' — `3`, `5`, `6`, `7`, `8`, `9`, `10`, `11` — the values are
 * *imported* from `../report/codes.ts` and `../triage/codes.ts` rather than restated as numerals
 * here. A restated numeral is a second source that can drift silently; an import cannot, and the
 * checked-in `/report` contract already sits behind its own binary on `7` and `11` (#4752), which is
 * why the shipped package is the authority and no prose copy is.
 *
 * **`12`-`15` are this group's private band, and are deliberately not cleared against sibling
 * groups.** `triage` seats `12`/`13` on its own two refusals; that is two namespaces, not one
 * collision, because the `3`+ band carries no cross-group uniqueness obligation — see rule 3 of
 * `../../../../claude-plugins/fabrika/docs/cli-interface-convention.md`, which also names the one
 * condition that would change it. `../exit-code-alignment.ts` checks this band against the base
 * only, matching that scope.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 * `4` stays a deliberate gap — it is `report file`'s body-section seat, and no verb here performs
 * one; a row for it would be a meaning this group does not have.
 */

import {
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** The **authored** text carries a machine-local path. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The **authored** text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)** or closed, the PR has zero changed files or zero
 * declared check runs, or a required block is proven absent or malformed (ADR 0092).
 *
 * *Proven* is the operative word. A 404 is a fact about the repository; an unreachable GitHub is not
 * a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** The write itself failed — the outcome is **UNKNOWN**, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A supplied classification value is off the closed vocabulary — namespace, polarity or carrier. */
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
/** A precondition read failed — nothing was written and the outcome is UNKNOWN. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Refused: the live head moved past the inspected `--sha`.
 *
 * The one code whose absence would let a verdict formed over one tree land on another — `bindToHead`'s
 * `Stale` arm applied at the write seam (#3769 / #4338's class, ADR 0058).
 */
export const STALE_HEAD = 12;
/**
 * Refused: the read completed and its scope is **provably incomplete**.
 *
 * Neither {@link PRECONDITION_UNKNOWN} (nothing failed) nor {@link ZERO_SCOPE} (scope exists; it just
 * was not all seen). Folding it into either renders a half-seen PR as a fully-judged one — the class
 * of #3925 and #4060.
 */
export const INCOMPLETE_SCAN = 13;
/** Refused: the invoking token resolves below `write`, or the ACL lookup failed (ADR 0055). */
export const ACL_DENIED = 14;
/** Refused: the write would drop or mutate an existing row — the append-only fence. */
export const APPEND_ONLY = 15;

/** The unallocated code — see the gap note at the top of this file. */
export const DELIBERATE_GAP = 4;
