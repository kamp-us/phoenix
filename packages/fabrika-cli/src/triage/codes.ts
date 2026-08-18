/**
 * The one exit table all nine `triage` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * `0`, `1`, `126` and `127` are reserved by the interface convention (see `../verb.ts` and the
 * bootstrap failure in `../bin.ts`); everything else here is `3` and up, the band a verb owns for
 * outcomes it PROVED. `2` is allocated by nothing anywhere in fabrika — it is the harness's block
 * code on `PreToolUse` (`../hook/harness-exit.ts`, #5423).
 *
 * **The alignment with `report` is deliberate, code-for-code, and re-exported rather than
 * re-typed.** Where this table overlaps `report`'s two writing verbs — `3`, `5`, `6`, `7`, `8`, `9`,
 * `10`, `11` — the values are *imported* from `../report/codes.ts`, so a caller driving `report` and
 * `triage` in one sweep reads one meaning and a drift between the two is unrepresentable rather than
 * merely detectable (`../review/codes.ts` set the precedent; `../exit-code-alignment.ts` owns the
 * policy and checks the direction an import cannot cover — that the codes added below clear
 * `report`'s whole table). That alignment does **not** extend repo-wide: `wire` allocates `3`-`6`
 * for facts about an artifact, so its `3` is *the format's block is provably not in it*.
 *
 * **`4` is a deliberate gap, not a free slot.** It once held "the target issue does not exist, or is
 * not readable" — a proven fact and an unknown fused into one code. {@link ZERO_SCOPE} and
 * {@link PRECONDITION_UNKNOWN} took the halves; leaving `4` unallocated keeps the alignment with
 * `report file`, where it is a body-section failure no verb here performs.
 */

import {
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";

/** The answer is on stdout. Restated here because {@link TRIAGE_EXIT_TABLE} spans the whole matrix. */
const ANSWER = 0;
/** Usage error, an unresolvable repo, or the verb failed to run. */
const FAILED = 1;

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** The **authored** text carries a machine-local path and it was not redacted. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/**
 * The **authored** text is a bare `@` path reference — **not** redactable.
 *
 * Separate from {@link LEAKED_PATH} because the fixes are opposite: the caller's loop on a path
 * refusal is *redact and re-send*, and on a body that IS a path that loop never terminates.
 */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/**
 * Zero scope: a read that succeeded over nothing, an absent label vocabulary, or a target issue
 * **proven absent (404)** or closed — a fail-closed refusal (ADR 0092).
 *
 * *Proven* is the operative word. A 404 is a fact about the repository; an unreachable GitHub is not
 * a fact about anything, and lands on {@link PRECONDITION_UNKNOWN} instead.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/**
 * The write itself failed, so the outcome is **UNKNOWN** — deliberately not `1`.
 *
 * A create or PATCH that times out may or may not have landed. Seating that on `1` would make
 * "GitHub refused the write" indistinguishable from "the binary is broken", which is the
 * verdict-versus-invocation collision the reserved range exists to prevent (#4208, #4219). Each
 * message carries its recovery instruction, because a blind retry is how one split becomes two
 * children.
 */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match. The artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/**
 * The supplied classification value is not permitted in this position — off a closed enum, or a
 * `--home` naming a milestone that is not open.
 *
 * The superset that keeps `report`'s reading true: there `10` is a title or `--label` carrying a
 * type or priority. A closed milestone is an off-vocabulary home, so it belongs with the enum
 * refusals rather than with the shape errors.
 */
export const OFF_VOCABULARY = REPORT_CLASSIFIED;
/** A precondition read failed — nothing was written and no outcome is proven. `report`'s `11`. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;
/**
 * Refused: the issue is human-filed.
 *
 * `12`, not `11`, because `11` already means `PRECONDITION_UNKNOWN` in the shipped `report` table
 * this group aligns to. Issue #4831's acceptance criteria state `11`/`12` for this pair; the merged
 * contract's `12`/`13` wins, and the divergence is disclosed rather than silently resolved. That
 * clearance is now checked both ways — `../exit-code-alignment.ts` reds if either table moves into
 * the other's seat.
 */
export const HUMAN_FILED = 12;
/** Refused: agent-filed and close-eligible, but the kill is unconfirmed (ADR 0159). */
export const UNCONFIRMED = 13;
/**
 * Refused: the acceptance-criteria block is drifted in a way no mechanical repair covers.
 *
 * `repair-criteria` may fix exactly one defect — a heading whose text is already exactly
 * `Acceptance criteria` and whose only drift is the level. Anything else (drifted text, multiple
 * headings, a section with no checkbox items, a drift living only inside the preserved original) is
 * this refusal: rewriting it would be indistinguishable from inventing a contract, which is the one
 * thing the review gate is forbidden to do.
 */
export const UNREPAIRABLE = 14;
/**
 * Refused: the **authored region of the composed body** carries an acceptance-criteria block the
 * wire reader classifies `Malformed`.
 *
 * Every downstream consumer (`build issue`, `review criteria`) reads the block through
 * `../wire/acceptance-criteria.ts` and rejects exactly what it rejects, so writing it to a body only
 * defers the refusal to a lane that cannot fix it (#5565, ADR 0288). `Absent` stays allowed: an
 * issue with no criteria block is a fact, not a defect, and this code never turns enrich into
 * "every issue must have criteria".
 *
 * Distinct from {@link UNREPAIRABLE}, which is `repair-criteria`'s answer about a block already on
 * the board. This one is `enrich`'s answer about a block that has not landed yet, so the fix is a
 * re-send rather than a hand-edit.
 */
export const MALFORMED_CRITERIA = 15;
/**
 * Refused: `--ready-for agent` over a body whose acceptance-criteria block the wire reader does not
 * answer `Found` on.
 *
 * `ready-for:agent` is the promise that a builder can pick the issue up cold, and the criteria block
 * is what the promise is made of — so the stamp asserts it at the cheapest door there is. Without
 * this seat the contract is first read at `review criteria`, once a branch, a build, a push, a PR
 * and a CI run have already been spent on an issue that never carried one (#6025).
 *
 * Its own code rather than {@link MALFORMED_CRITERIA}'s: that one is `enrich`'s answer about a body
 * it composed and has not written yet, and it allows `Absent` deliberately. This one is `apply`'s
 * answer about a body already on the board, where `Absent` is the case it exists to refuse.
 */
export const CRITERIA_REQUIRED = 16;

/** The verb never ran (unresolved binary). The shell's, not this process's — no constant owns it. */
const NEVER_RAN = 127;

/** One row of the shared matrix: a code and the single meaning it carries across the group. */
export interface ExitCodeRow {
	readonly code: number;
	readonly meaning: string;
}

/**
 * The whole matrix in ascending order — the machine-readable form of the contract's table.
 *
 * The reserved rows sit here beside the allocated ones because the matrix owns what a code *means*
 * while each verb's `--help` owns what *triggers* it. `4` is absent: it is unallocated, and a row
 * for it would be a meaning.
 */
export const TRIAGE_EXIT_TABLE: ReadonlyArray<ExitCodeRow> = [
	{code: ANSWER, meaning: "the answer is on stdout"},
	{code: FAILED, meaning: "usage error, unresolvable repo, or the verb failed to run"},
	{code: EMPTY_STDIN, meaning: "stdin was read and held nothing"},
	{code: LEAKED_PATH, meaning: "the authored text carries a machine-local path"},
	{code: BARE_AT_PATH, meaning: "the authored text is a bare @ path reference — not redactable"},
	{
		code: ZERO_SCOPE,
		meaning:
			"zero scope: a read that succeeded over nothing, an absent label vocabulary, or a target issue proven absent (404) or closed",
	},
	{code: WRITE_UNKNOWN, meaning: "the write itself failed — the outcome is UNKNOWN"},
	{code: READBACK_MISMATCH, meaning: "the write landed but the read-back does not match"},
	{code: OFF_VOCABULARY, meaning: "the supplied classification value is not permitted here"},
	{
		code: PRECONDITION_UNKNOWN,
		meaning: "a precondition read failed — nothing was written and the outcome is UNKNOWN",
	},
	{code: HUMAN_FILED, meaning: "refused: the issue is human-filed"},
	{
		code: UNCONFIRMED,
		meaning: "refused: agent-filed and close-eligible, but the kill is unconfirmed (ADR 0159)",
	},
	{
		code: UNREPAIRABLE,
		meaning:
			"refused: the acceptance-criteria drift is not mechanically repairable — not a pure level drift on exact heading text",
	},
	{
		code: MALFORMED_CRITERIA,
		meaning:
			"refused: the composed body's authored region carries an acceptance-criteria block the wire reader classifies Malformed",
	},
	{
		code: CRITERIA_REQUIRED,
		meaning:
			"refused: --ready-for agent over a body carrying no acceptance-criteria block the wire reader answers Found on",
	},
	{code: NO_IMPLEMENTATION, meaning: "no implementation could be resolved"},
	{code: NEVER_RAN, meaning: "the verb never ran (unresolved binary)"},
];

/** The unallocated code — see the gap note at the top of this file. */
export const DELIBERATE_GAP = 4;
