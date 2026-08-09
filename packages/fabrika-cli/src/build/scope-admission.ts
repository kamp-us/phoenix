/**
 * The admission test both `build` seams run — **two named axes composed, never one widened term**
 * (`claude-plugins/fabrika/skills/build/contract.md`, the admission test; ADR 0245).
 *
 * - **Scope admission** is campaign membership and nothing else: is the issue's home the milestone in
 *   exclusive focus? It refuses on {@link OUT_OF_FOCUS}.
 * - **The audience axis** is who the work is for (`ready-for:agent`), a question older than the fence
 *   (#4780). This module *hosts* it; it does not redefine it. It refuses on {@link AUDIENCE_NOT_AGENT}.
 *
 * They are siblings with different remedies — edit the focus row, or re-label the audience — so they
 * stay separately named, separately seated and separately reported everywhere. A single predicate
 * answering both questions at once is the shape the contract's repair round removed; every outcome
 * below therefore carries **both** axis verdicts, so a caller can never lose one behind the other.
 *
 * The core is pure and total, and this module is **imported** by the pool and claim seams rather than
 * invoked through a relaying verb (the wrapper shape ADR 0238 bans). Only {@link readDeclaredFocus}
 * touches IO.
 */
import {Effect, type FileSystem, Result} from "effect";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {AUDIENCE_NOT_AGENT, BAD_SECTIONS, OUT_OF_FOCUS, PRECONDITION_UNKNOWN} from "./codes.ts";

/** The declaration's file, relative to the repository root. */
export const DEFAULT_ROADMAP = "ROADMAP.md";

/**
 * The labels that are a home in their own right (ADR 0208), admitted on the scope axis whatever the
 * declaration says.
 *
 * A standing lane is milestone-less **by design**, so a fence keyed on milestone-presence alone would
 * starve 199 open issues for a campaign's duration (#5088's measured count). The exemption is the
 * label match and nothing else: bare milestone-absence never confers it, and the set is closed — a
 * third lane is a founder ruling and a deliberate edit here, never a pattern match.
 */
export const STANDING_LANE_LABELS = ["wayfinder:backlog", "axis:pipeline-hardening"] as const;
export type StandingLaneLabel = (typeof STANDING_LANE_LABELS)[number];

/** The one audience an agent lane may open against. */
export const READY_FOR_AGENT = "ready-for:agent";
const READY_FOR_PREFIX = "ready-for:";

/** Everything either axis reads off an issue — no derived field, and nothing else. */
export interface IssueFacts {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly milestone: number | null;
}

/** An issue's home: its open milestone's number as a string, or its standing lane. */
export const homeOf = (issue: IssueFacts): string | null =>
	issue.milestone !== null
		? String(issue.milestone)
		: (STANDING_LANE_LABELS.find((lane) => issue.labels.includes(lane)) ?? null);

/**
 * The `## Focus` declaration.
 *
 * `None` is a **well-formed default**, not a refusal: declaring nothing is the off switch, and a fence
 * that refused on absence would wedge the board the moment nobody had declared a focus. `Malformed` is
 * the opposite — a declaration that reads but does not parse proves nothing, and is never read as "no
 * focus".
 */
export type Focus =
	| {readonly _tag: "Declared"; readonly milestone: number; readonly declared: string}
	| {readonly _tag: "None"}
	| {readonly _tag: "Malformed"; readonly reason: string};

/** A focus that parsed — the only input the scope axis accepts, so `Malformed` cannot reach it. */
export type ParsedFocus = Exclude<Focus, {readonly _tag: "Malformed"}>;

const HEADING = /^##\s+Focus\s*$/;
const ANY_HEADING = /^##\s+/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;
const MILESTONE_CELL = /^#(\d+)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const cellsOf = (line: string): ReadonlyArray<string> | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return null;
	return trimmed
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
};

const isSeparator = (cells: ReadonlyArray<string>): boolean =>
	cells.every((cell) => SEPARATOR_CELL.test(cell));

const isHeader = (cells: ReadonlyArray<string>): boolean =>
	cells.length === 2 &&
	cells[0]?.toLowerCase() === "milestone" &&
	cells[1]?.toLowerCase() === "declared";

/** Whether the date is the calendar day it spells, not merely four-two-two digits. */
const isCalendarDate = (year: string, month: string, day: string): boolean => {
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	return (
		date.getUTCFullYear() === Number(year) &&
		date.getUTCMonth() === Number(month) - 1 &&
		date.getUTCDate() === Number(day)
	);
};

/**
 * Read `ROADMAP.md`'s `## Focus` table.
 *
 * The header row is recognised by its column names and the separator by its dashes, so what is left is
 * a data row **whatever it contains** — which is what makes a mistyped milestone cell malformed rather
 * than invisible. Skipping unrecognised rows instead would answer "no focus declared" for a broken
 * table, the well-formed-and-always-wrong shape that fence exists to avoid.
 */
export const readFocus = (text: string): Focus => {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => HEADING.test(line.trim()));
	if (start === -1) return {_tag: "None"};

	const rows: ReadonlyArray<string>[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (ANY_HEADING.test(line.trim())) break;
		const cells = cellsOf(line);
		if (cells === null || isSeparator(cells) || isHeader(cells)) continue;
		rows.push(cells);
	}

	if (rows.length === 0) return {_tag: "None"};
	if (rows.length > 1) {
		return {
			_tag: "Malformed",
			reason: `the ## Focus table carries ${rows.length} data rows — exclusive focus admits at most one`,
		};
	}
	const row = rows[0] ?? [];
	if (row.length !== 2) {
		return {
			_tag: "Malformed",
			reason: `the ## Focus row has ${row.length} cells, not the 2 the grammar declares (Milestone | Declared)`,
		};
	}
	const milestone = MILESTONE_CELL.exec(row[0] ?? "");
	if (milestone?.[1] === undefined) {
		return {_tag: "Malformed", reason: `the milestone cell "${row[0]}" is not #<int>`};
	}
	const date = ISO_DATE.exec(row[1] ?? "");
	if (
		date?.[1] === undefined ||
		date[2] === undefined ||
		date[3] === undefined ||
		!isCalendarDate(date[1], date[2], date[3])
	) {
		return {
			_tag: "Malformed",
			reason: `the declared cell "${row[1]}" is not an ISO YYYY-MM-DD date`,
		};
	}
	return {_tag: "Declared", milestone: Number.parseInt(milestone[1], 10), declared: row[1] ?? ""};
};

/** Axis one — campaign membership, and nothing else. */
export type ScopeAxis =
	/** A focus is declared and this is its milestone. */
	| {readonly _tag: "InFocus"; readonly milestone: number}
	/** A standing lane, admitted whatever the declaration says. */
	| {readonly _tag: "LaneExempt"; readonly lane: StandingLaneLabel}
	/** No focus is declared — the fence is off, and says so. */
	| {readonly _tag: "Inert"}
	| {readonly _tag: "OutOfFocus"; readonly focus: number; readonly home: string | null};

/** Axis two — who the work is for. Older than the fence (#4780); hosted here, never redefined. */
export type AudienceAxis =
	| {readonly _tag: "Agent"}
	/** `label` is the `ready-for:` label carried, or `null` when the issue carries none. */
	| {readonly _tag: "NotAgent"; readonly label: string | null};

export const scopeAxisOf = (focus: ParsedFocus, issue: IssueFacts): ScopeAxis => {
	if (focus._tag === "None") return {_tag: "Inert"};
	if (issue.milestone === focus.milestone) return {_tag: "InFocus", milestone: focus.milestone};
	const lane = STANDING_LANE_LABELS.find((label) => issue.labels.includes(label));
	if (lane !== undefined) return {_tag: "LaneExempt", lane};
	return {_tag: "OutOfFocus", focus: focus.milestone, home: homeOf(issue)};
};

/** Absence is an unknown audience, never an agent audience (#4780). */
export const audienceAxisOf = (issue: IssueFacts): AudienceAxis =>
	issue.labels.includes(READY_FOR_AGENT)
		? {_tag: "Agent"}
		: {
				_tag: "NotAgent",
				label: issue.labels.find((label) => label.startsWith(READY_FOR_PREFIX)) ?? null,
			};

/**
 * The composed answer: exactly one of four state words, never a boolean.
 *
 * Both axis verdicts ride on every outcome, including the refusals, so the two questions stay legible
 * apart no matter which one refused.
 */
export type Admission =
	| {readonly _tag: "Admitted"; readonly scope: ScopeAxis; readonly audience: AudienceAxis}
	| {
			readonly _tag: "OutOfFocus";
			readonly scope: Extract<ScopeAxis, {readonly _tag: "OutOfFocus"}>;
			readonly audience: AudienceAxis;
	  }
	| {
			readonly _tag: "AudienceNotAgent";
			readonly scope: ScopeAxis;
			readonly audience: Extract<AudienceAxis, {readonly _tag: "NotAgent"}>;
	  }
	| {readonly _tag: "Unknown"; readonly code: number; readonly reason: string};

/**
 * Run both axes over one issue.
 *
 * **Scope is reported before audience when both refuse**, deliberately: while an issue sits outside the
 * campaign in focus its audience label is not the thing to fix, and reporting the audience first would
 * send an operator to re-label work that the scope fence would refuse again. The unreported axis is
 * still on the outcome.
 */
export const admissionOf = (focus: Focus, issue: IssueFacts): Admission => {
	if (focus._tag === "Malformed") {
		return {
			_tag: "Unknown",
			code: BAD_SECTIONS,
			reason: `${focus.reason} — malformed is never read as "no focus"`,
		};
	}
	const scope = scopeAxisOf(focus, issue);
	const audience = audienceAxisOf(issue);
	if (scope._tag === "OutOfFocus") return {_tag: "OutOfFocus", scope, audience};
	if (audience._tag === "NotAgent") return {_tag: "AudienceNotAgent", scope, audience};
	return {_tag: "Admitted", scope, audience};
};

/** The word `build pick` reports per excluded issue; `null` for an admitted one. */
export const exclusionReasonOf = (
	admission: Admission,
): "out-of-focus" | "audience-not-agent" | "unreadable" | null => {
	switch (admission._tag) {
		case "Admitted":
			return null;
		case "OutOfFocus":
			return "out-of-focus";
		case "AudienceNotAgent":
			return "audience-not-agent";
		default:
			return "unreadable";
	}
};

/**
 * Every non-zero code this test can produce, with the condition that produces it — single-sourced so a
 * consuming verb's `--help` enumerates them rather than restating them.
 */
export const ADMISSION_EXIT_CODES: ReadonlyArray<{
	readonly code: number;
	readonly condition: string;
}> = [
	{
		code: BAD_SECTIONS,
		condition: "the ## Focus declaration reads but does not parse — malformed, never 'no focus'",
	},
	{
		code: PRECONDITION_UNKNOWN,
		condition: "the declaration or the issue's home could not be read — admission is UNKNOWN",
	},
	{
		code: OUT_OF_FOCUS,
		condition:
			"proven: not admitted on the scope axis — the issue's home is not the declared milestone and no standing-lane label exempts it",
	},
	{
		code: AUDIENCE_NOT_AGENT,
		condition: `proven: not admitted on the audience axis — the issue's ${READY_FOR_PREFIX} label is not ${READY_FOR_AGENT}, or is absent`,
	},
];

/** The scope line both seams print, so an operator sees the fence's state rather than inferring it. */
export const focusScopeLine = (verb: string, focus: Focus): string => {
	switch (focus._tag) {
		case "Declared":
			return `${verb}: focus: milestone #${focus.milestone}, declared ${focus.declared}.`;
		case "None":
			return `${verb}: focus: none declared — scope fence inert.`;
		default:
			return `${verb}: focus: unreadable — ${focus.reason}.`;
	}
};

/** The `focus` field both seams report on the machine channel, beside the stderr scope line. */
export const focusReport = (
	focus: Focus,
): {readonly state: "declared"; readonly milestone: string} | {readonly state: "none"} =>
	focus._tag === "Declared"
		? {state: "declared", milestone: String(focus.milestone)}
		: {state: "none"};

/**
 * The seated refusal for a non-admitted outcome, or `null` when the issue is admitted.
 *
 * The seating lives here rather than at each seam so `20`, `21`, `4` and `11` cannot drift apart
 * between the pool and the claim path — the disagreement ADR 0245 calls worse than no fence at all.
 */
export const admissionRefusal = (verb: string, admission: Admission): VerbOutcome | null => {
	switch (admission._tag) {
		case "Admitted":
			return null;
		case "OutOfFocus": {
			const home = admission.scope.home ?? "no milestone and no standing lane";
			return refuse(
				OUT_OF_FOCUS,
				`${verb}: out of focus — the declared focus is milestone #${admission.scope.focus} and this issue's home is ${home}; edit the ## Focus row, or claim it with an explicit override.`,
			);
		}
		case "AudienceNotAgent":
			return refuse(
				AUDIENCE_NOT_AGENT,
				`${verb}: audience not agent — this issue carries ${
					admission.audience.label ??
					`no ${READY_FOR_PREFIX} label, and absence is an unknown audience`
				}, not ${READY_FOR_AGENT}.`,
			);
		default:
			return refuse(admission.code, `${verb}: ${admission.reason} — admission is UNKNOWN.`);
	}
};

/**
 * An input that could not be read, lifted into the composed outcome.
 *
 * Both the declaration and an issue's home come through here, so no seam ever seats `11` for itself
 * and no read failure can be talked into an `admitted`.
 */
export const unknownAdmission = (reason: string): Admission => ({
	_tag: "Unknown",
	code: PRECONDITION_UNKNOWN,
	reason,
});

/** A declaration read off disk, or the reason it could not be. */
export type FocusRead =
	| {readonly _tag: "Read"; readonly focus: Focus}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const unreadable = (path: string, failure: ReadFailed): FocusRead => ({
	_tag: "Unreadable",
	reason: `cannot read the focus declaration at ${path}: ${failure.reason}`,
});

/**
 * Read the declaration.
 *
 * An **absent file** and an absent section are the same well-formed default — no focus — while a file
 * that is there and cannot be read is UNKNOWN. The probe is separate from the read for exactly that
 * split: a probe that cannot be performed is itself UNKNOWN, never "absent".
 */
export const readDeclaredFocus = (
	path: string = DEFAULT_ROADMAP,
): Effect.Effect<FocusRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const probe = yield* Effect.result(exists(path));
		if (Result.isFailure(probe)) return unreadable(path, probe.failure);
		if (!probe.success) return {_tag: "Read" as const, focus: {_tag: "None" as const}};
		const read = yield* Effect.result(readFile(path));
		return Result.isFailure(read)
			? unreadable(path, read.failure)
			: {_tag: "Read" as const, focus: readFocus(read.success)};
	});
