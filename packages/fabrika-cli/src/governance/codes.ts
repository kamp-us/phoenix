/**
 * The one exit table all seven `governance` verbs allocate from, so a code means one thing across
 * this group whichever verb produced it
 * (`claude-plugins/fabrika/skills/governance/contract.md`, the shared exit taxonomy).
 *
 * Every shared seat is **imported**, never restated as a numeral: a restated numeral is a second
 * source that can drift silently, and an import cannot. Each import comes from the module that owns
 * the meaning this group proves — `report` for the writing seats, `triage` for the off-vocabulary
 * one (its `OFF_VOCABULARY` *is* `report`'s `CLASSIFIED`, so there is no numeric difference to hunt
 * for; the name is where the reading is stated), and `review` for the two facts this group proves
 * identically.
 *
 * Three readings on this table are one another's opposites, and keeping them apart is the whole
 * point: `1`/`127` is *the call never decided*, {@link PRECONDITION_UNKNOWN} is *a precondition read
 * failed and nothing was written*, {@link WRITE_UNKNOWN} is *a write was attempted and its outcome
 * is UNKNOWN*, and every code at `3` and above is something a verb **proved** — with nothing on
 * stdout (`../verb.ts`'s `refuse` hardcodes that).
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";
import {
	INCOMPLETE_SCAN as REVIEW_INCOMPLETE_SCAN,
	STALE_HEAD as REVIEW_STALE_HEAD,
} from "../review/codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

/** Stdin was read and held nothing. `governance post` and `governance readout` only. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
/** The **authored** text carries a machine-local path. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;
/** The **authored** text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven absent (404)** or closed, the PR has zero changed files, the
 * corpus holds zero decision records, the window holds zero landings, or the readout artifact is
 * proven absent — a fail-closed refusal (ADR 0092).
 *
 * *Proven* is the operative word. A 404 is a fact about the repository; an unreachable GitHub is not
 * a fact about anything and lands on {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = SHARED_NO_TARGET;
/** The write itself failed — the outcome is **UNKNOWN**, deliberately not `1`. */
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
/**
 * A supplied value is off the closed vocabulary — a bad `--polarity`, a `--sha` that is not a head
 * SHA, an unparseable `--since`, a `--record` that is not a four-digit id, a `--path` outside this
 * skill's own resolved directory.
 */
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
/** A precondition read failed — nothing was written and the outcome is UNKNOWN. */
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/** Refused: the `--sha` given is not the PR's head — `review`'s seat, for the same proven fact. */
export const STALE_HEAD = REVIEW_STALE_HEAD;
/** Refused: the read completed and its scope is **provably incomplete** — `review`'s seat again. */
export const INCOMPLETE_SCAN = REVIEW_INCOMPLETE_SCAN;

/**
 * Refused: this PR's diff derives **no** governance namespace.
 *
 * This group's one private seat, and deliberately **declared here rather than imported**. It is not
 * {@link OFF_VOCABULARY}: that is a value off a closed vocabulary, a caller typo. This is a *proven
 * fact about the PR* — the diff was read, bound and partitioned, and it derives no governance
 * namespace. Folding them would make "you asked wrongly" and "this PR is not mine to judge" one
 * number, and only the second is safe to treat as a clean skip. `review/codes.ts` seats its own `14`
 * as `ACL_DENIED`; that is a different group's private band and carries no cross-group uniqueness
 * obligation, so importing `14` from `review` beside `12` and `13` would silently take the wrong
 * meaning (interface convention rule 3).
 */
export const NOT_HARNESS_TOUCHING = 14;

/**
 * The unallocated code: `report file`'s body-section seat, which no verb here performs.
 *
 * Registered rather than silently absent, so the gap is a decision the alignment check can read
 * (`../exit-code-alignment.ts` excludes this export from a table's allocations).
 */
export const DELIBERATE_GAP = 4;
