/**
 * The one exit table every `eval` verb allocates from, so a code means one thing across the group.
 *
 * Before this table the group seated *every* refusal on `1` — a decoded-and-invalid manifest and a
 * manifest that could not be read exited alike, so a caller reading `$?` could not tell a verdict
 * the verb PROVED from a failure to invoke it (`../verb.ts`, #4208/#4219). What stays on `1` is
 * exactly what the convention reserves it for: a usage error (a flag naming something that is not a
 * stage, a surface, or an arm) and a read that failed before the verb could judge anything.
 *
 * The shared seats are **imported from the base, never re-typed** — the discipline
 * `../review-ui/codes.ts` states, and the reason `../exit-code-alignment.ts` can check them. `12`
 * and up are this group's own.
 *
 * `0`, `1` and `127` are reserved by the interface convention (`../verb.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/**
 * A named artifact was read in full and does not conform: a corpus manifest, a runner-rows file, a
 * `/skill-creator` eval set, a ruled-KEEP enumeration, or a provenance ledger.
 *
 * The base's section seat, widened to whole documents the same way `../review-ui/codes.ts` widens
 * it. Deliberately not `1`: the bytes were in hand and the schema answered, so this is a fact about
 * the artifact. A read that never produced bytes is the `1` above.
 */
export const MALFORMED_DOCUMENT = REPORT_BAD_SECTIONS;

/**
 * Zero scope, proven: the artifact decodes and carries no eval cases (ADR 0092).
 *
 * A suite that ran nothing and exited 0 is the vacuous pass the ADR forbids, so the emptiness is an
 * outcome with its own seat rather than a green with a caveat on stderr.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;

/**
 * The write-path seats, imported from the base with its meanings unchanged (`eval post`, #5411).
 *
 * They arrive as a block because they arrived with one verb: until `post` the group neither read
 * stdin nor wrote anything, so every fact these name was unreachable here. Each keeps the base's
 * name as well as its number, which is what lets `../exit-code-alignment.ts` record the claim that
 * the two meanings are one rather than merely that the two numbers match.
 */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
export const LEAKED_PATH = REPORT_LEAKED_PATH;
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * Proven: the ruled-KEEP enumeration decodes but breaks its own integrity rules.
 *
 * Its own seat rather than {@link MALFORMED_DOCUMENT} because the caller's remedy differs — the
 * schema is satisfied, so no decoder change can help; a human has to reconcile the membership list.
 */
export const INTEGRITY_VIOLATION = 12;

/**
 * Proven: the suite completed and at least one planned run did not execute.
 *
 * Not a failed invocation — the runner ran, the ledger is on stdout, and this reports only that the
 * evidence is incomplete. Whether the executed runs *passed* is the oracle's answer downstream, and
 * never this code.
 */
export const RUNS_NOT_EXECUTED = 13;

/**
 * Proven: the graded axis ran and produced no measurement at all — every run of every case returned
 * no verdict, so the record it emitted is `UNRECORDABLE`.
 *
 * Its own seat, and deliberately not a failure of the verb: the record is on stdout and is meant to
 * be posted. This says only that there is no number in it, which the merge gate must be able to tell
 * apart from a below-bar number (ADR 0253 §2). A below-bar run exits `0` — whether a rate clears the
 * ruled bar is #4681's judgement and never this verb's.
 */
export const NO_MEASUREMENT = 14;

/**
 * Proven: the candidate's spend on the corpus is ABOVE the recorded v1 baseline (#4679).
 *
 * A judged outcome, so it gets its own seat rather than {@link MALFORMED_DOCUMENT}'s — the artifacts
 * were both readable and the ceiling was applied. It is the phase-1 answer #4637 ruling 3 asks for,
 * and it is deliberately distinct from {@link BASELINE_INCOMPARABLE} below.
 */
export const ABOVE_BASELINE = 15;

/**
 * Proven: the two sides did not price the same work, so no ceiling answer exists.
 *
 * Separate from {@link ABOVE_BASELINE} because the remedies are opposite: an above-baseline run is a
 * cost regression to fix, while an incomparable pair is a measurement to redo. Collapsing them would
 * let a candidate that ran a different case set read as a cost failure, or — worse the other way —
 * let a caller treat "could not compare" as a pass.
 */
export const BASELINE_INCOMPARABLE = 16;

/**
 * Proven: a scorecard was assembled and is not committable — a pin is blank, a cell cites no eval
 * record, or two cells claim one cell key.
 *
 * Its own seat rather than {@link MALFORMED_DOCUMENT} because the artifact is well-formed and the
 * remedy is upstream: the run that produced the records has to name what it was measured on. The pin
 * is a precondition of the artifact, not a field a writer may leave out (#4637 ruling 4).
 */
export const NOT_COMMITTABLE = 17;

/**
 * Proven: the record's `sha` is not the PR's live head, so the tree it measured is gone.
 *
 * A measurement is re-run at the new head, never re-bound to it — re-binding would publish a number
 * taken over one tree as if it had been taken over another. `../review/codes.ts` seats the same fact
 * on `12`; this group's `12` is {@link INTEGRITY_VIOLATION}, so cross-group divergence above `11` is
 * the doctrine and the refusal is re-seated here rather than imported (ADR 0253).
 */
export const STALE_HEAD = 18;

/**
 * Proven: the comment enumeration is short of the count the platform declared.
 *
 * Its own seat because the upsert's match is then *unprovable* rather than negative: a sweep that
 * missed the comment this record owes an edit to would create a second one, and two comments on one
 * `(head, cell)` is exactly what ADR 0253's key forbids.
 */
export const INCOMPLETE_SCAN = 19;

/**
 * Proven: the pull request is absent (404) or closed, so a record has no home there.
 *
 * Deliberately not {@link ZERO_SCOPE}: this group widened `7` to *the eval set carries zero cases*,
 * and one number may not carry two facts inside one group.
 */
export const TARGET_ABSENT = 20;

/**
 * Proven: the merge gate found no eval record at all for the head under gate (#4681).
 *
 * The other half of {@link STALE_HEAD}, and separate from it because the two name different skips.
 * A stale record says the review ran and the tree moved; this says the review step never left
 * anything, which is the path a forgotten step takes. Neither may read as "nothing to check" — the
 * gate's whole guarantee is that absence reds (founder ruling on #4649).
 */
export const MISSING_RESULT = 21;

/**
 * Proven: a recorded graded pass rate at the head under gate is under the ruled 90% (#4637 ruling 2).
 *
 * Its own seat rather than {@link NO_MEASUREMENT}'s: that one says the run produced no number, this
 * one says it produced a number below the bar, and the remedies are opposite. The trend co-gate
 * never reaches this seat — it ships observe-only (ADR 0252 §4).
 */
export const BELOW_BAR = 22;

/**
 * Proven: an armed incident-derived case did not pass, so the 100% regression floor is broken.
 *
 * Executed in CI with no model in the loop, and seated apart from {@link BELOW_BAR} because the
 * floor admits no tolerance and no quarantine while the graded bar is a rate — collapsing them
 * would let a caller treat one regressing incident case as a percentage-point dip.
 */
export const REGRESSION_FLOOR = 23;
