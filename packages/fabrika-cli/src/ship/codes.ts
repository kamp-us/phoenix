/**
 * The one exit table every `ship` verb allocates from, so a code means one thing across this group
 * whichever verb produced it.
 *
 * **Every seat this group shares is imported, never re-typed as a numeral.** `3`, `5`, `6`, `7`,
 * `8`, `9`, `10` and `11` come from `../report/codes.ts` and `../triage/codes.ts`; `12` and `13`
 * come from `../review/codes.ts` and `23` from `../plan/codes.ts`, whose meanings this group holds
 * unchanged. A restated numeral is a second source that can drift silently; an import cannot.
 *
 * `16` and `17` are this group's own proven refusals, and they sit above `review`'s private band on
 * purpose — `14`/`15` are `review`'s ACL and append-only seats, meanings no verb here performs, so a
 * row for either would be a meaning this group does not have.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {LABEL_ABSENT as PLAN_LABEL_ABSENT} from "../plan/codes.ts";
import {
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";
import {
	INCOMPLETE_SCAN as REVIEW_INCOMPLETE_SCAN,
	STALE_HEAD as REVIEW_STALE_HEAD,
} from "../review/codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

/** Stdin was read and held nothing — `ship resolve`, `ship note`. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** The **authored** text carries a machine-local path. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The **authored** text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)**, the PR is closed/draft where the verb requires
 * an open one, or it has zero changed files (ADR 0092).
 *
 * *Proven* is the operative word — a 404 is a fact about the repository, an unreachable GitHub is
 * not a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** The write, or the read that confirms it, failed — the outcome is **UNKNOWN**. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A supplied classification value is off the closed vocabulary — a `--require`, a `--site`. */
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
/** A precondition read failed — nothing was proven and (for a write) nothing was written. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/** Refused: the live head moved past the inspected `--sha` — `review`'s seat, same meaning. */
export const STALE_HEAD = REVIEW_STALE_HEAD;
/** Refused: a read completed but its scope is **provably incomplete** — `review`'s seat. */
export const INCOMPLETE_SCAN = REVIEW_INCOMPLETE_SCAN;

/**
 * Refused: the target is **proven not in the state this write acts on** — nothing was mutated.
 *
 * Neither {@link ZERO_SCOPE} (the target exists) nor {@link PRECONDITION_UNKNOWN} (nothing failed).
 * It is #4816 made structural: the verb that mutates re-derives its own precondition and declines.
 */
export const PROVEN_NOT_IN_STATE = 16;
/**
 * Refused: the nudge's close landed and the reopen is **unconfirmed — the PR may be left closed**.
 *
 * The group's one two-legged mutation, and the one state so much worse than a failed write that
 * folding it into {@link WRITE_UNKNOWN} would hide the fact the operator must act on immediately.
 */
export const NUDGE_REOPEN_UNCONFIRMED = 17;

/**
 * Refused: the diff touches a governance root and its `governance` verdict is **not** a head-bound
 * PASS — `absent`, `stale` or `fail` (`ship floor`, #5408).
 *
 * Its own seat rather than a fold into {@link PROVEN_NOT_IN_STATE}, because a CI job keys on it: this
 * is the one refusal a red check means "a human owes this PR a governance verdict", and every other
 * non-zero from that job means the floor could not be resolved at all.
 */
export const GOVERNANCE_FLOOR_UNMET = 18;

/**
 * Refused: a label this run would POST is absent from the repository's taxonomy (#4285).
 *
 * `plan`'s seat, imported, under `plan`'s own rule — *import a code when two groups prove the same
 * fact*. `plan flip` and `ship release` prove one fact here, on one board, over the same taxonomy:
 * the label the write is about to create does not exist, so the write would mint it. The operator
 * drives both in one sweep, and two verbs proving one fact on two codes is the collision that bites.
 *
 * Not {@link ZERO_SCOPE}, which `triage apply`/`park` reach for the same refusal: this group
 * documents `7` as the **target** proven absent, and the target here — the PR, the linked issue —
 * exists. Folding an absent label into it would make `7` two facts in one group.
 */
export const LABEL_ABSENT = PLAN_LABEL_ABSENT;

/**
 * The unallocated codes. `4` is `report file`'s body-section seat and `14`/`15` are `review`'s ACL
 * and append-only seats; no verb here performs any of the three. Excluded from the alignment
 * check's allocations — reading a gap as an allocation reports a collision on a seat nobody sits in.
 */
export const DELIBERATE_GAP = 4;
