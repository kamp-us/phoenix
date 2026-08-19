/**
 * The admission test both `build` seams run — **two named axes composed, never one widened term**
 * (`claude-plugins/fabrika/skills/build/contract.md`, the admission test; ADR 0245).
 *
 * - **Scope admission** is campaign membership and nothing else: is the issue's home one of the
 *   milestones in declared focus? It refuses on {@link OUT_OF_FOCUS}.
 * - **The audience axis** is who the work is for (`ready-for:agent`), a question older than the fence
 *   (#4780). This module *hosts* it; it does not redefine it. It refuses on {@link AUDIENCE_NOT_AGENT}.
 * - **The type axis** is whether the deliverable is a pull request at all. It refuses on
 *   {@link TYPE_NOT_BUILDABLE}, and it lives here rather than in the pool because the pool is the
 *   browse path: a number handed straight to `claim` passes through no pool, so a type rule fenced
 *   only there is no fence (#5490).
 *
 * They are siblings with different remedies — edit the focus row, re-label the audience, or take the
 * work to the skill whose lane it is — so they stay separately named, separately seated and
 * separately reported everywhere. A single predicate answering all three questions at once is the
 * shape the contract's repair round removed; every outcome below therefore carries **every** axis
 * verdict, so a caller can never lose one behind another.
 *
 * A claim's {@link ClaimPurpose} rides **beside** those axes: it decides whether the audience axis
 * *binds* this claim, and it never enters either axis's own reading (#5175).
 *
 * The core is pure and total, and this module is **imported** by the pool and claim seams rather than
 * invoked through a relaying verb (the wrapper shape ADR 0238 bans). Only {@link readDeclaredFocus}
 * touches IO.
 */
import {Effect, type FileSystem, Result} from "effect";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {issueRefOf} from "../review/classes.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	AUDIENCE_NOT_AGENT,
	BAD_SECTIONS,
	OUT_OF_FOCUS,
	PRECONDITION_UNKNOWN,
	TYPE_NOT_BUILDABLE,
} from "./codes.ts";

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

/**
 * The type whose deliverable is a recorded choice rather than a pull request — `/adr`'s lane.
 *
 * Triage routes such an issue to `ready-for:human` by default, which is the collision
 * {@link RepairClaim} answers: an ADR PR's repair lane would otherwise fail a fence it could not
 * pass. The default is not an exclusion — a decision issue carrying a founder ruling comment is
 * buildable as transcription, and triage may route that one to `ready-for:agent` instead (ADR 0300).
 * Which ones it does is triage's per-issue judgement; this axis reads the audience label it finds
 * and never infers one from the type, in either direction.
 */
export const DECISION_TYPE_LABEL = "type:decision";

/** The type whose deliverable is a ledger of children rather than one pull request — `plan-epic`'s. */
export const EPIC_TYPE_LABEL = "type:epic";

/**
 * The four types an agent build lane may take — the type axis's whole vocabulary, declared once.
 *
 * The pool used to own a private copy of this set, so the claim seam could not see it and a
 * directly-handed `type:decision` was admitted with no refusal at all (#5490). One declaration is
 * what makes the two seams unable to disagree, the same rule ADR 0245 states for the other axes.
 */
export const BUILDABLE_TYPE_LABELS = [
	"type:feature",
	"type:chore",
	"type:bug",
	"type:investigation",
] as const;

const TYPE_PREFIX = "type:";

/**
 * Axis three — whether the deliverable is a pull request an agent build lane produces.
 *
 * An issue carrying **no** `type:` label is `Buildable` here, which is deliberate and is not this
 * axis's judgement to make: it is the pool's long-standing reading, preserved so this axis changes
 * where the rule is enforced without changing what the rule says. The untyped hole is its own
 * defect on its own ticket (#5490's triage note).
 */
export type TypeAxis =
	/** Every `type:` label carried is one of {@link BUILDABLE_TYPE_LABELS}, or none is carried. */
	| {readonly _tag: "Buildable"}
	/** `label` is the first carried `type:` label outside the buildable set. */
	| {readonly _tag: "NotBuildable"; readonly label: string};

export const typeAxisOf = (issue: IssueFacts): TypeAxis => {
	const barred = issue.labels
		.filter((label) => label.startsWith(TYPE_PREFIX))
		.find((label) => !BUILDABLE_TYPE_LABELS.some((buildable) => buildable === label));
	return barred === undefined ? {_tag: "Buildable"} : {_tag: "NotBuildable", label: barred};
};

/**
 * A founder ruling recorded on the issue, named by the comment it lives in.
 *
 * It is what opens the type axis on a `type:decision`: once the choosing has happened on the board,
 * the deliverable is transcription and transcription is a pull request like any other (founder
 * ruling on [#5879](https://github.com/kamp-us/phoenix/issues/5879#issuecomment-5335398768)). The
 * citation is the fence — an agent points at the comment or it refuses — so what this module can
 * check is the pointer's shape and its target, never whether the comment rules anything. Judging
 * that stays the reader's, and the arm is worth exactly as much as that honesty: it rules out a
 * citation that names some other issue, not one that names the wrong comment.
 */
export type Citation =
	| {readonly _tag: "None"}
	| {
			readonly _tag: "Cited";
			readonly issue: number;
			readonly commentId: number;
			/** The URL as written, already proven to name this repository and this issue. */
			readonly url: string;
	  };

/** No ruling was cited — the reading every seam but a `--cites` claim takes. */
export const NO_CITATION: Citation = {_tag: "None"};

const CITATION_URL =
	/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)#issuecomment-(\d+)$/;

/** The canonical shape a citation is written in, quoted in every refusal that asks for one. */
export const CITATION_GRAMMAR =
	"https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<comment-id>";

export type CitationRead =
	| {readonly _tag: "Read"; readonly citation: Citation}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * Read a `--cites` value against the repository and issue the claim is actually addressed to.
 *
 * Both bindings are the point: a URL naming another repository or another issue is a ruling recorded
 * somewhere else, and admitting it would let one founder comment unlock every decision on the board.
 */
export const parseCitation = (value: string, repo: string, issue: number): CitationRead => {
	const trimmed = value.trim();
	const match = CITATION_URL.exec(trimmed);
	if (match === null) {
		return {
			_tag: "Malformed",
			reason: `"${trimmed}" is not an issue-comment URL — the grammar is ${CITATION_GRAMMAR}`,
		};
	}
	const [, owner, name, cited, commentId] = match;
	if (`${owner}/${name}` !== repo) {
		return {
			_tag: "Malformed",
			reason: `"${trimmed}" names ${owner}/${name}, not ${repo} — a ruling recorded in another repository rules nothing here`,
		};
	}
	if (Number(cited) !== issue) {
		return {
			_tag: "Malformed",
			reason: `"${trimmed}" names issue #${cited}, not #${issue} — the ruling has to be recorded on the issue being claimed`,
		};
	}
	return {
		_tag: "Read",
		citation: {_tag: "Cited", issue, commentId: Number(commentId), url: trimmed},
	};
};

/** Everything either axis reads off an issue — no derived field, and nothing else. */
export interface IssueFacts {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly milestone: number | null;
}

/** What a subject read needs off the target — the PR/issue split, and the body the link lives in. */
export interface SubjectFacts {
	readonly isPullRequest: boolean;
	readonly body: string;
}

/**
 * Whose home the admission test judges.
 *
 * An issue is its own subject. A pull request is not: it carries no milestone and no `ready-for:`
 * label, so a fence reading the PR's own record refused **every** repair claim while any focus was
 * declared (#5562). A PR's lane serves a ticket, and that ticket's home is the campaign membership
 * the fence is actually asking about — so the PR resolves to it, through the same body reference
 * `review scope` reads (`issueRefOf`), never a second parser.
 */
export type ScopeSubject =
	| {readonly _tag: "Own"}
	| {readonly _tag: "Served"; readonly number: number; readonly kind: "fixes" | "part-of"}
	/** A PR whose body names no issue at all — there is nothing to resolve to. */
	| {readonly _tag: "Unserved"};

export const scopeSubjectOf = (target: SubjectFacts): ScopeSubject => {
	if (!target.isPullRequest) return {_tag: "Own"};
	const ref = issueRefOf(target.body);
	return ref.kind === "none" || ref.number === null
		? {_tag: "Unserved"}
		: {_tag: "Served", number: ref.number, kind: ref.kind};
};

/** An issue's home: its open milestone's number as a string, or its standing lane. */
export const homeOf = (issue: IssueFacts): string | null =>
	issue.milestone !== null
		? String(issue.milestone)
		: (STANDING_LANE_LABELS.find((lane) => issue.labels.includes(lane)) ?? null);

/** One parsed `## Focus` data row: a milestone the fence admits, and the date it was declared. */
export interface FocusRow {
	readonly milestone: number;
	readonly declared: string;
}

/**
 * The `## Focus` declaration — a **set** of milestones, one per data row (#6005).
 *
 * `None` is a **well-formed default**, not a refusal: declaring nothing is the off switch, and a fence
 * that refused on absence would wedge the board the moment nobody had declared a focus. `Malformed` is
 * the opposite — a declaration that reads but does not parse proves nothing, and is never read as "no
 * focus".
 *
 * `Declared` carries a non-empty tuple, so "declared, admitting nothing" — a set that refuses the whole
 * board while reporting a focus — cannot be constructed.
 */
export type Focus =
	| {readonly _tag: "Declared"; readonly milestones: readonly [FocusRow, ...FocusRow[]]}
	| {readonly _tag: "None"}
	| {readonly _tag: "Malformed"; readonly reason: string};

/** A focus that parsed — the only input the scope axis accepts, so `Malformed` cannot reach it. */
export type ParsedFocus = Exclude<Focus, {readonly _tag: "Malformed"}>;

/** The milestones a parsed declaration admits — empty when the fence is inert. */
export const declaredMilestones = (focus: ParsedFocus): ReadonlyArray<number> =>
	focus._tag === "Declared" ? focus.milestones.map((row) => row.milestone) : [];

/** `milestone #46`, or `milestones #46, #47` — the phrase every focus-naming message shares. */
export const milestonePhrase = (milestones: ReadonlyArray<number>): string =>
	`${milestones.length === 1 ? "milestone" : "milestones"} ${milestones
		.map((milestone) => `#${milestone}`)
		.join(", ")}`;

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
 * Read `ROADMAP.md`'s `## Focus` table into the set of milestones it declares.
 *
 * The header row is recognised by its column names and the separator by its dashes, so what is left is
 * a data row **whatever it contains** — which is what makes a mistyped milestone cell malformed rather
 * than invisible. Skipping unrecognised rows instead would answer "no focus declared" for a broken
 * table, the well-formed-and-always-wrong shape that fence exists to avoid.
 *
 * One unreadable row makes the **whole** declaration malformed rather than degrading to the rows that
 * did parse: a partial read reported as the focus is a fence quietly narrower than what was written.
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

	const parsed: FocusRow[] = [];
	for (const [index, row] of rows.entries()) {
		const where = rows.length === 1 ? "the ## Focus row" : `## Focus row ${index + 1}`;
		if (row.length !== 2) {
			return {
				_tag: "Malformed",
				reason: `${where} has ${row.length} cells, not the 2 the grammar declares (Milestone | Declared)`,
			};
		}
		const milestone = MILESTONE_CELL.exec(row[0] ?? "");
		if (milestone?.[1] === undefined) {
			return {_tag: "Malformed", reason: `${where}'s milestone cell "${row[0]}" is not #<int>`};
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
				reason: `${where}'s declared cell "${row[1]}" is not an ISO YYYY-MM-DD date`,
			};
		}
		parsed.push({milestone: Number.parseInt(milestone[1], 10), declared: row[1] ?? ""});
	}
	const [first, ...rest] = parsed;
	return first === undefined ? {_tag: "None"} : {_tag: "Declared", milestones: [first, ...rest]};
};

/** Axis one — campaign membership, and nothing else. */
export type ScopeAxis =
	/** A focus is declared and this issue's home is one of its milestones — the member matched. */
	| {readonly _tag: "InFocus"; readonly milestone: number}
	/** A standing lane, admitted whatever the declaration says. */
	| {readonly _tag: "LaneExempt"; readonly lane: StandingLaneLabel}
	/** No focus is declared — the fence is off, and says so. */
	| {readonly _tag: "Inert"}
	| {
			readonly _tag: "OutOfFocus";
			readonly focus: ReadonlyArray<number>;
			readonly home: string | null;
	  };

/** Axis two — who the work is for. Older than the fence (#4780); hosted here, never redefined. */
export type AudienceAxis =
	| {readonly _tag: "Agent"}
	/** `label` is the `ready-for:` label carried, or `null` when the issue carries none. */
	| {readonly _tag: "NotAgent"; readonly label: string | null};

export const scopeAxisOf = (focus: ParsedFocus, issue: IssueFacts): ScopeAxis => {
	if (focus._tag === "None") return {_tag: "Inert"};
	const matched = focus.milestones.find((row) => row.milestone === issue.milestone);
	if (matched !== undefined) return {_tag: "InFocus", milestone: matched.milestone};
	const lane = STANDING_LANE_LABELS.find((label) => issue.labels.includes(label));
	if (lane !== undefined) return {_tag: "LaneExempt", lane};
	return {_tag: "OutOfFocus", focus: declaredMilestones(focus), home: homeOf(issue)};
};

/**
 * Why a lane claims — `plan`, `gate`, or `build`. A closed enum, never a policy map.
 *
 * The audience axis answers "should an agent pick this up to **build**", and an epic only earns
 * `ready-for:agent` *after* it has been planned and gated — so fencing the planner and the gate on it
 * is circular (founder ruling, #5175: 19 of 20 open epics carried no such label). Purpose is how a
 * claim says which question it is asking, and it is deliberately a third input rather than a widening
 * of either axis: {@link scopeAxisOf} and {@link audienceAxisOf} read an issue exactly as before, and
 * only {@link admissionOf}'s composition consults the purpose.
 */
export const CLAIM_PURPOSES = ["plan", "gate", "build"] as const;
export type ClaimPurpose = (typeof CLAIM_PURPOSES)[number];

/** The purpose a claim carries when none is named — behaviour-preserving, so the fence stays on. */
export const DEFAULT_CLAIM_PURPOSE: ClaimPurpose = "build";

/** The named purpose, or `null` for a value off the enum — a caller refuses, never falls back. */
export const parseClaimPurpose = (value: string): ClaimPurpose | null =>
	CLAIM_PURPOSES.find((purpose) => purpose === value) ?? null;

/**
 * Whether this claim repairs an open pull request, and whether the issue that PR serves is a
 * decision.
 *
 * A claim's target is either an issue — a fresh build — or an open PR, which can only be a repair:
 * the PR exists, so "should an agent start this" is already answered. The word is therefore
 * **derived from the target**, never typed. A `--purpose repair` flag would be passable against a
 * bare issue, which is a state the seam would then have to refuse; deriving it means the only way to
 * be in repair is to name a PR (founder ruling on #5866, #5914).
 */
export type RepairClaim =
	/** The target is an issue and judges itself — no PR is in flight. */
	| {readonly _tag: "NotRepair"}
	/** An open PR serves this issue, whose deliverable is a recorded decision. */
	| {readonly _tag: "DecisionRepair"; readonly pr: number}
	/** An open PR serves this issue, and the issue is not a decision. */
	| {readonly _tag: "OrdinaryRepair"; readonly pr: number};

/** The reading every seam but the claim path takes: the pool judges issues, never a PR in flight. */
export const NOT_REPAIR: RepairClaim = {_tag: "NotRepair"};

/** Read the repair state off an open PR and the issue the fence judges in its place. */
export const repairClaimOf = (pr: number, served: IssueFacts): RepairClaim =>
	served.labels.includes(DECISION_TYPE_LABEL)
		? {_tag: "DecisionRepair", pr}
		: {_tag: "OrdinaryRepair", pr};

/**
 * Only a build-purpose claim is bound by the audience axis (#5175), and not even that one when it
 * repairs an open PR whose served issue is a decision. Scope binds every purpose and every repair.
 *
 * The exemption is narrow on purpose, and it is read off the target being a PR rather than off the
 * pairing being impossible: triage routes a decision to `ready-for:human` by default, so an ADR PR's
 * repair lane would otherwise stall on a label nobody changes mid-flight. An ordinary repair still
 * reads the audience label, so an issue re-routed to a human mid-flight still stops a builder — the
 * founder's ruling exempts decisions, not repair at large.
 */
export const audienceAxisBinds = (
	purpose: ClaimPurpose,
	repair: RepairClaim = NOT_REPAIR,
): boolean => purpose === "build" && repair._tag !== "DecisionRepair";

/**
 * The type axis binds a **fresh build** and nothing else.
 *
 * `plan` and `gate` claim epics by design — that is the whole reason those purposes exist (#5175) —
 * and a repair claim names a PR, whose existence already answers "should an agent produce a pull
 * request here". So the axis asks its question at the one moment the answer is still open: an issue
 * being picked up cold to build.
 */
export const typeAxisBinds = (purpose: ClaimPurpose, repair: RepairClaim = NOT_REPAIR): boolean =>
	purpose === "build" && repair._tag === "NotRepair";

/**
 * Whether a cited ruling opens the type axis on this label.
 *
 * One label has an arm and the rest do not: a `type:decision` whose choice is already recorded is
 * transcription, which an agent may build (founder ruling on #5879, comment 5335398768). An epic's
 * deliverable is a ledger no citation turns into a pull request, so it has no arm at all.
 */
export const citationOpens = (label: string, citation: Citation): boolean =>
	label === DECISION_TYPE_LABEL && citation._tag === "Cited";

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
	| {
			readonly _tag: "Admitted";
			readonly scope: ScopeAxis;
			readonly audience: AudienceAxis;
			readonly type: TypeAxis;
			/** The ruling that opened the type axis, or `None` — so an arm taken is read, not inferred. */
			readonly citation: Citation;
	  }
	| {
			readonly _tag: "OutOfFocus";
			readonly scope: Extract<ScopeAxis, {readonly _tag: "OutOfFocus"}>;
			readonly audience: AudienceAxis;
			readonly type: TypeAxis;
	  }
	| {
			readonly _tag: "TypeNotBuildable";
			readonly scope: ScopeAxis;
			readonly audience: AudienceAxis;
			readonly type: Extract<TypeAxis, {readonly _tag: "NotBuildable"}>;
	  }
	| {
			readonly _tag: "AudienceNotAgent";
			readonly scope: ScopeAxis;
			readonly audience: Extract<AudienceAxis, {readonly _tag: "NotAgent"}>;
			readonly type: TypeAxis;
	  }
	/**
	 * A pull request with no readable served issue, under a declared focus.
	 *
	 * It carries no axis verdict because neither axis ever ran: the fence could not identify the
	 * record to judge. Refusing is the fail-closed answer — admitting a PR whose ticket nobody can
	 * name would let any lane past a declared focus by omitting one line from a body — and the
	 * remedy is a cheap one the message states: name the issue in the PR body, or override.
	 */
	| {
			readonly _tag: "NoServedIssue";
			readonly pr: number;
			readonly focus: ReadonlyArray<number>;
			readonly reason: string;
	  }
	| {readonly _tag: "Unknown"; readonly code: number; readonly reason: string};

export const noServedIssue = (
	pr: number,
	focus: ReadonlyArray<number>,
	reason: string,
): Admission => ({
	_tag: "NoServedIssue",
	pr,
	focus,
	reason,
});

/**
 * Run both axes over one issue.
 *
 * The refusals are ordered scope, then type, then audience, and the order is the operator's remedy
 * path rather than a preference. While an issue sits outside the campaign in focus, neither its type
 * nor its audience label is the thing to fix. Inside the focus, type outranks audience because a
 * decision or an epic reported as `audience-not-agent` sends an operator to re-label work that is
 * not a build lane's under any label — the misnaming #5490 was filed on. Every unreported axis is
 * still on the outcome.
 *
 * `purpose`, `repair` and `citation` decide only whether a refusal is *seated*; each axis's verdict
 * is read and reported either way, so a claim admitted over a non-agent audience still says so.
 */
export const admissionOf = (
	focus: Focus,
	issue: IssueFacts,
	purpose: ClaimPurpose = DEFAULT_CLAIM_PURPOSE,
	repair: RepairClaim = NOT_REPAIR,
	citation: Citation = NO_CITATION,
): Admission => {
	if (focus._tag === "Malformed") {
		return {
			_tag: "Unknown",
			code: BAD_SECTIONS,
			reason: `${focus.reason} — malformed is never read as "no focus"`,
		};
	}
	const scope = scopeAxisOf(focus, issue);
	const audience = audienceAxisOf(issue);
	const type = typeAxisOf(issue);
	if (scope._tag === "OutOfFocus") return {_tag: "OutOfFocus", scope, audience, type};
	if (
		type._tag === "NotBuildable" &&
		typeAxisBinds(purpose, repair) &&
		!citationOpens(type.label, citation)
	) {
		return {_tag: "TypeNotBuildable", scope, audience, type};
	}
	if (audience._tag === "NotAgent" && audienceAxisBinds(purpose, repair)) {
		return {_tag: "AudienceNotAgent", scope, audience, type};
	}
	return {_tag: "Admitted", scope, audience, type, citation};
};

/** The word `build pick` reports per excluded issue; `null` for an admitted one. */
export const exclusionReasonOf = (
	admission: Admission,
): "out-of-focus" | "audience-not-agent" | "type-not-buildable" | "unreadable" | null => {
	switch (admission._tag) {
		case "Admitted":
			return null;
		case "OutOfFocus":
		// The pool reads issues only, so this arrives from the claim path alone; it is a scope-axis
		// refusal there, and it is reported as one here rather than as an unreadable issue.
		case "NoServedIssue":
			return "out-of-focus";
		case "AudienceNotAgent":
			return "audience-not-agent";
		case "TypeNotBuildable":
			return "type-not-buildable";
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
			"proven: not admitted on the scope axis — the issue's home is none of the declared milestones and no standing-lane label exempts it, or the target is a pull request naming no served issue to judge",
	},
	{
		code: TYPE_NOT_BUILDABLE,
		condition: `proven: not admitted on the type axis — the issue carries ${DECISION_TYPE_LABEL} or ${EPIC_TYPE_LABEL}, not one of ${BUILDABLE_TYPE_LABELS.join(" / ")}; reachable only under purpose build against an issue, and opened on a decision by --cites naming a founder ruling comment recorded on that issue`,
	},
	{
		code: AUDIENCE_NOT_AGENT,
		condition: `proven: not admitted on the audience axis — the issue's ${READY_FOR_PREFIX} label is not ${READY_FOR_AGENT}, or is absent; reachable only under purpose build, and never when an open PR serves a ${DECISION_TYPE_LABEL} issue`,
	},
];

/** The purpose line the claim seam prints, so an exempted audience is read rather than inferred. */
export const purposeScopeLine = (
	verb: string,
	purpose: ClaimPurpose,
	audience: AudienceAxis,
	repair: RepairClaim = NOT_REPAIR,
): string => {
	const carried =
		audience._tag === "Agent"
			? READY_FOR_AGENT
			: (audience.label ?? `no ${READY_FOR_PREFIX} label`);
	if (repair._tag === "DecisionRepair") {
		return `${verb}: purpose: ${purpose} — repairing open PR #${repair.pr}, whose served issue is ${DECISION_TYPE_LABEL}: the audience axis does not bind (#5914); this issue carries ${carried}.`;
	}
	return audienceAxisBinds(purpose)
		? `${verb}: purpose: ${purpose} — the audience axis binds; this issue carries ${carried}.`
		: `${verb}: purpose: ${purpose} — the audience axis does not bind a ${purpose} claim (#5175); this issue carries ${carried}.`;
};

/**
 * The type line, or `null` on the ordinary case where the issue's type is buildable.
 *
 * A taken arm is the one thing here nobody may have to infer: when a citation admits a decision, the
 * comment it points at is printed, so the transcription's authority is on the record beside the
 * claim rather than only inside whatever the lane later writes.
 */
export const typeScopeLine = (
	verb: string,
	type: TypeAxis,
	citation: Citation = NO_CITATION,
): string | null => {
	if (type._tag === "Buildable") return null;
	return citationOpens(type.label, citation) && citation._tag === "Cited"
		? `${verb}: type: ${type.label} — admitted as transcription of the founder ruling at ${citation.url}; the deliverable is that ruling written down, nothing more.`
		: `${verb}: type: ${type.label} — the type axis binds a build claim against an issue.`;
};

/** The scope line both seams print, so an operator sees the fence's state rather than inferring it. */
export const focusScopeLine = (verb: string, focus: Focus): string => {
	switch (focus._tag) {
		case "Declared": {
			const [only] = focus.milestones;
			return focus.milestones.length === 1
				? `${verb}: focus: milestone #${only.milestone}, declared ${only.declared}.`
				: `${verb}: focus: ${focus.milestones.length} milestones — ${focus.milestones
						.map((row) => `#${row.milestone} (declared ${row.declared})`)
						.join(", ")}.`;
		}
		case "None":
			return `${verb}: focus: none declared — scope fence inert.`;
		default:
			return `${verb}: focus: unreadable — ${focus.reason}.`;
	}
};

/** The `focus` field both seams report on the machine channel, beside the stderr scope line. */
export const focusReport = (
	focus: Focus,
):
	| {readonly state: "declared"; readonly milestones: ReadonlyArray<string>}
	| {readonly state: "none"} =>
	focus._tag === "Declared"
		? {state: "declared", milestones: focus.milestones.map((row) => String(row.milestone))}
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
				`${verb}: out of focus — the declared focus is ${milestonePhrase(admission.scope.focus)} and this issue's home is ${home}; add a ## Focus row, or claim it with an explicit override.`,
			);
		}
		case "NoServedIssue":
			return refuse(
				OUT_OF_FOCUS,
				`${verb}: no served issue — the declared focus is ${milestonePhrase(admission.focus)} and PR #${admission.pr} ${admission.reason}, so there is no ticket whose home the fence can judge; name the issue in the PR body (a closing keyword or "Part of #<n>"), or claim it with an explicit override.`,
			);
		case "TypeNotBuildable":
			return refuse(
				TYPE_NOT_BUILDABLE,
				`${verb}: type not buildable — this issue carries ${admission.type.label}, whose deliverable is not a pull request an agent build lane produces; ${
					admission.type.label === DECISION_TYPE_LABEL
						? `a decision is /adr's lane unless the choice is already recorded on it, in which case pass --cites ${CITATION_GRAMMAR} naming that founder ruling comment`
						: `an epic is plan-epic's lane — claim it with --purpose plan or --purpose gate`
				}.`,
			);
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
