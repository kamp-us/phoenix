/**
 * The admission test both `build` seams run — **four named axes composed, never one widened term**
 * (`claude-plugins/fabrika/skills/build/contract.md`, the admission test; ADR 0245).
 *
 * - **Scope admission** is campaign membership and nothing else: is the issue's home pinned by a
 *   `## Campaigns` row whose state is `active`? It refuses on {@link OUT_OF_SCOPE}.
 * - **The audience axis** is who the work is for (`ready-for:agent`), a question older than the fence
 *   (#4780). This module *hosts* it; it does not redefine it. It refuses on {@link AUDIENCE_NOT_AGENT}.
 * - **The type axis** is whether the deliverable is a pull request at all. It refuses on
 *   {@link TYPE_NOT_BUILDABLE}, and it lives here rather than in the pool because the pool is the
 *   browse path: a number handed straight to `claim` passes through no pool, so a type rule fenced
 *   only there is no fence (#5490).
 * - **The criteria axis** is whether the body carries a contract to build against. It refuses on
 *   {@link NO_ACCEPTANCE_CRITERIA}, and it is here for exactly the reason the type axis is: the pool
 *   held it privately, so `build issue <n>` built a no-AC issue the pool would have refused and the
 *   review gate was the first thing to catch it (#6554).
 *
 * They are siblings with different remedies — flip the campaign's state cell, re-label the audience,
 * take the work to the skill whose lane it is, or repair the issue body — so they stay separately
 * named, separately seated and separately reported everywhere. A single predicate answering all four
 * questions at once is the shape the contract's repair round removed; every outcome below therefore
 * carries **every** axis verdict, so a caller can never lose one behind another.
 *
 * A claim's {@link ClaimPurpose} rides **beside** those axes: it decides which of them *bind* this
 * claim, and it never enters any axis's own reading (#5175).
 *
 * The core is pure and total, and this module is **imported** by the pool and claim seams rather than
 * invoked through a relaying verb (the wrapper shape ADR 0238 bans). Only {@link readDispatch}
 * touches IO.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {CONFIG_PATH} from "../config/document.ts";
import {readRoadmapFile} from "../config/paths.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {issueRefOf} from "../review/classes.ts";
import {EPIC_TYPE_LABEL} from "../triage/facets.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	AUDIENCE_NOT_AGENT,
	BAD_SECTIONS,
	NO_ACCEPTANCE_CRITERIA,
	OUT_OF_SCOPE,
	PRECONDITION_UNKNOWN,
	TYPE_NOT_BUILDABLE,
} from "./codes.ts";

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

/**
 * The epic type label, re-exported at the seam that fences on it — defined once in
 * `triage/facets.ts`, where the `--type` vocabulary it derives from lives.
 */
export {EPIC_TYPE_LABEL};

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
 * Axis four — whether the issue carries a contract to build against (#6554).
 *
 * It reads through the shared `wire/acceptance-criteria` read and keeps that read's three answers
 * apart: `Found` contracts, and `Absent` and `Malformed` are two different defects with two different
 * repairs. Both refuse — a heading drifted by one character is no more gradeable than no heading at
 * all, and `build pick` has always excluded the pair on one test — but the reason travels so the
 * refusal can name the right route out.
 *
 * The axis lived in the pool as a private constant, which is what made it no fence at all: a number
 * handed straight to `claim` passes through no pool, so `build issue <n>` built the same no-AC issue
 * the pool refused, and the review gate was the first thing to catch it (#6554, on #6462 → PR #6552).
 * That is the reasoning {@link typeAxisOf} already carries from #5490, and it moves the rule here
 * without changing what the rule says.
 */
export type CriteriaAxis =
	/** A readable `### Acceptance criteria` block — the lane has something to build against. */
	| {readonly _tag: "Contracted"}
	/** No contract: `state` is the wire read's own token, `reason` its own words. */
	| {
			readonly _tag: "NoContract";
			readonly state: "absent" | "malformed";
			readonly reason: string;
	  };

/**
 * The word every seam reports a criteria refusal under, declared once beside the axis.
 *
 * The pool owned it privately while the rule lived there; it stays the same string so an operator
 * reading an `excluded` histogram sees no rename, and no second spelling can drift into existence.
 */
export const NO_CRITERIA_REASON = "no-acceptance-criteria";

export const criteriaAxisOf = (issue: IssueFacts): CriteriaAxis => {
	const read = readCriteria(issue.body);
	if (read._tag === "Found") return {_tag: "Contracted"};
	return {
		_tag: "NoContract",
		state: read._tag === "Absent" ? "absent" : "malformed",
		reason: read.reason,
	};
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

/** Everything the axes read off an issue — no derived field, and nothing else. */
export interface IssueFacts {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly milestone: number | null;
	/** The issue body, `""` when the payload carried none — the criteria axis's whole input. */
	readonly body: string;
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

/**
 * The lifecycle cell of a `## Campaigns` row.
 *
 * `paused` is the campaign that is alive and not being executed: its milestone is open and no lane
 * opens against it (ADR 0304). It is what makes one cell able to answer "may a lane open here"
 * without a second declaration surface stacked on top.
 */
export const CAMPAIGN_STATES = ["active", "paused", "done"] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

/** One `## Campaigns` row whose state is `active` — a milestone the fence admits, and its name. */
export interface ActiveCampaign {
	readonly milestone: number;
	readonly name: string;
}

/**
 * What `## Campaigns` permits — the **set** of milestones its `active` rows pin (ADR 0304).
 *
 * `None` is a **well-formed default**, not a refusal: an absent table, a table with no rows and a
 * table whose every row is `paused` or `done` are one answer — the fence is off, not closed — and a
 * fence that refused on absence would wedge the board the moment nobody was running a campaign.
 * `Malformed` is the opposite: a table that reads but does not parse proves nothing, and is never
 * read as "nothing is active".
 *
 * `Active` carries a non-empty tuple, so "permitting nothing while reporting a permission" cannot be
 * constructed.
 */
export type Dispatch =
	| {readonly _tag: "Active"; readonly campaigns: readonly [ActiveCampaign, ...ActiveCampaign[]]}
	| {readonly _tag: "None"}
	| {readonly _tag: "Malformed"; readonly reason: string};

/** A table that parsed — the only input the scope axis accepts, so `Malformed` cannot reach it. */
export type ParsedDispatch = Exclude<Dispatch, {readonly _tag: "Malformed"}>;

/** The milestones a parsed table admits — empty when the fence is inert. */
export const dispatchMilestones = (dispatch: ParsedDispatch): ReadonlyArray<number> =>
	dispatch._tag === "Active" ? dispatch.campaigns.map((row) => row.milestone) : [];

/** `milestone #46`, or `milestones #46, #47` — the phrase every focus-naming message shares. */
export const milestonePhrase = (milestones: ReadonlyArray<number>): string =>
	`${milestones.length === 1 ? "milestone" : "milestones"} ${milestones
		.map((milestone) => `#${milestone}`)
		.join(", ")}`;

const HEADING = /^##\s+Campaigns\s*$/;
const ANY_HEADING = /^##\s+/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;
const MILESTONE_CELL = /^#(\d+)$/;

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
	cells.length === 3 &&
	cells[0]?.toLowerCase() === "campaign" &&
	cells[1]?.toLowerCase() === "milestone" &&
	cells[2]?.toLowerCase() === "state";

/**
 * Read `ROADMAP.md`'s `## Campaigns` table into the set of milestones its `active` rows permit.
 *
 * The header row is recognised by its column names and the separator by its dashes, so what is left is
 * a data row **whatever it contains** — which is what makes a mistyped state cell malformed rather than
 * invisible. Skipping unrecognised rows instead would answer "nothing is active" for a broken table,
 * the well-formed-and-always-wrong shape this fence exists to avoid.
 *
 * One unreadable row makes the **whole** table malformed rather than degrading to the rows that did
 * parse (ADR 0298's rule, carried onto the surface that replaced it): a partial read reported as the
 * permission is a fence quietly wider or narrower than what was written.
 */
export const readCampaigns = (text: string): Dispatch => {
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

	const active: ActiveCampaign[] = [];
	for (const [index, row] of rows.entries()) {
		const where = `## Campaigns row ${index + 1}`;
		if (row.length !== 3) {
			return {
				_tag: "Malformed",
				reason: `${where} has ${row.length} cells, not the 3 the grammar declares (Campaign | Milestone | State)`,
			};
		}
		const name = row[0] ?? "";
		if (name === "") {
			return {_tag: "Malformed", reason: `${where}'s campaign cell is empty`};
		}
		const milestone = MILESTONE_CELL.exec(row[1] ?? "");
		if (milestone?.[1] === undefined) {
			return {_tag: "Malformed", reason: `${where}'s milestone cell "${row[1]}" is not #<int>`};
		}
		const state = (row[2] ?? "").toLowerCase();
		if (!CAMPAIGN_STATES.some((legal) => legal === state)) {
			return {
				_tag: "Malformed",
				reason: `${where}'s state cell "${row[2]}" is none of ${CAMPAIGN_STATES.join(" / ")}`,
			};
		}
		if (state === "active") {
			active.push({milestone: Number.parseInt(milestone[1], 10), name});
		}
	}
	const [first, ...rest] = active;
	return first === undefined ? {_tag: "None"} : {_tag: "Active", campaigns: [first, ...rest]};
};

/** Axis one — campaign membership, and nothing else. */
export type ScopeAxis =
	/** An `active` campaign pins this issue's home — the member matched. */
	| {readonly _tag: "InScope"; readonly milestone: number}
	/** A standing lane, admitted whatever the table says. */
	| {readonly _tag: "LaneExempt"; readonly lane: StandingLaneLabel}
	/** No campaign is `active` — the fence is off, and says so. */
	| {readonly _tag: "Inert"}
	| {
			readonly _tag: "OutOfScope";
			readonly active: ReadonlyArray<number>;
			readonly home: string | null;
	  };

/** Axis two — who the work is for. Older than the fence (#4780); hosted here, never redefined. */
export type AudienceAxis =
	| {readonly _tag: "Agent"}
	/** `label` is the `ready-for:` label carried, or `null` when the issue carries none. */
	| {readonly _tag: "NotAgent"; readonly label: string | null};

export const scopeAxisOf = (dispatch: ParsedDispatch, issue: IssueFacts): ScopeAxis => {
	if (dispatch._tag === "None") return {_tag: "Inert"};
	const matched = dispatch.campaigns.find((row) => row.milestone === issue.milestone);
	if (matched !== undefined) return {_tag: "InScope", milestone: matched.milestone};
	const lane = STANDING_LANE_LABELS.find((label) => issue.labels.includes(label));
	if (lane !== undefined) return {_tag: "LaneExempt", lane};
	return {_tag: "OutOfScope", active: dispatchMilestones(dispatch), home: homeOf(issue)};
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
 * The criteria axis binds a **fresh build** and nothing else — {@link typeAxisBinds}'s shape, for two
 * reasons of its own.
 *
 * A `plan` or `gate` claim targets an epic, whose criteria arrive per child from the plan ledger and
 * never in its own body, so reading the block there would refuse exactly the claims that are supposed
 * to precede it (#6025). And a repair claim names a PR that already exists: refusing that would strand
 * the branch, because repairing an issue body is not something a build lane may do from one.
 */
export const criteriaAxisBinds = (
	purpose: ClaimPurpose,
	repair: RepairClaim = NOT_REPAIR,
): boolean => purpose === "build" && repair._tag === "NotRepair";

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
			readonly criteria: CriteriaAxis;
			/** The ruling that opened the type axis, or `None` — so an arm taken is read, not inferred. */
			readonly citation: Citation;
	  }
	| {
			readonly _tag: "OutOfScope";
			readonly scope: Extract<ScopeAxis, {readonly _tag: "OutOfScope"}>;
			readonly audience: AudienceAxis;
			readonly type: TypeAxis;
			readonly criteria: CriteriaAxis;
	  }
	| {
			readonly _tag: "TypeNotBuildable";
			readonly scope: ScopeAxis;
			readonly audience: AudienceAxis;
			readonly type: Extract<TypeAxis, {readonly _tag: "NotBuildable"}>;
			readonly criteria: CriteriaAxis;
	  }
	| {
			readonly _tag: "AudienceNotAgent";
			readonly scope: ScopeAxis;
			readonly audience: Extract<AudienceAxis, {readonly _tag: "NotAgent"}>;
			readonly type: TypeAxis;
			readonly criteria: CriteriaAxis;
	  }
	| {
			readonly _tag: "NoCriteria";
			readonly scope: ScopeAxis;
			readonly audience: AudienceAxis;
			readonly type: TypeAxis;
			readonly criteria: Extract<CriteriaAxis, {readonly _tag: "NoContract"}>;
	  }
	/**
	 * A pull request with no readable served issue, while some campaign is `active`.
	 *
	 * It carries no axis verdict because neither axis ever ran: the fence could not identify the
	 * record to judge. Refusing is the fail-closed answer — admitting a PR whose ticket nobody can
	 * name would let any lane past the fence by omitting one line from a body — and the remedy is a
	 * cheap one the message states: name the issue in the PR body, or override.
	 */
	| {
			readonly _tag: "NoServedIssue";
			readonly pr: number;
			readonly active: ReadonlyArray<number>;
			readonly reason: string;
	  }
	| {readonly _tag: "Unknown"; readonly code: number; readonly reason: string};

export const noServedIssue = (
	pr: number,
	active: ReadonlyArray<number>,
	reason: string,
): Admission => ({
	_tag: "NoServedIssue",
	pr,
	active,
	reason,
});

/**
 * Run both axes over one issue.
 *
 * The refusals are ordered scope, then type, then audience, and the order is the operator's remedy
 * path rather than a preference. While an issue sits outside every active campaign, neither its type
 * nor its audience label is the thing to fix. Inside one, type outranks audience because a decision
 * or an epic reported as `audience-not-agent` sends an operator to re-label work that is not a build
 * lane's under any label — the misnaming #5490 was filed on. Every unreported axis is still on the
 * outcome.
 *
 * `purpose`, `repair` and `citation` decide only whether a refusal is *seated*; each axis's verdict
 * is read and reported either way, so a claim admitted over a non-agent audience still says so.
 */
export const admissionOf = (
	dispatch: Dispatch,
	issue: IssueFacts,
	purpose: ClaimPurpose = DEFAULT_CLAIM_PURPOSE,
	repair: RepairClaim = NOT_REPAIR,
	citation: Citation = NO_CITATION,
): Admission => {
	if (dispatch._tag === "Malformed") {
		return {
			_tag: "Unknown",
			code: BAD_SECTIONS,
			reason: `${dispatch.reason} — malformed is never read as "nothing is active"`,
		};
	}
	const scope = scopeAxisOf(dispatch, issue);
	const audience = audienceAxisOf(issue);
	const type = typeAxisOf(issue);
	const criteria = criteriaAxisOf(issue);
	if (scope._tag === "OutOfScope") return {_tag: "OutOfScope", scope, audience, type, criteria};
	if (
		type._tag === "NotBuildable" &&
		typeAxisBinds(purpose, repair) &&
		!citationOpens(type.label, citation)
	) {
		return {_tag: "TypeNotBuildable", scope, audience, type, criteria};
	}
	if (audience._tag === "NotAgent" && audienceAxisBinds(purpose, repair)) {
		return {_tag: "AudienceNotAgent", scope, audience, type, criteria};
	}
	if (criteria._tag === "NoContract" && criteriaAxisBinds(purpose, repair)) {
		return {_tag: "NoCriteria", scope, audience, type, criteria};
	}
	return {_tag: "Admitted", scope, audience, type, criteria, citation};
};

/** The word `build pick` reports per excluded issue; `null` for an admitted one. */
export const exclusionReasonOf = (
	admission: Admission,
):
	| "out-of-scope"
	| "audience-not-agent"
	| "type-not-buildable"
	| typeof NO_CRITERIA_REASON
	| "unreadable"
	| null => {
	switch (admission._tag) {
		case "Admitted":
			return null;
		case "OutOfScope":
		// The pool reads issues only, so this arrives from the claim path alone; it is a scope-axis
		// refusal there, and it is reported as one here rather than as an unreadable issue.
		case "NoServedIssue":
			return "out-of-scope";
		case "AudienceNotAgent":
			return "audience-not-agent";
		case "TypeNotBuildable":
			return "type-not-buildable";
		case "NoCriteria":
			return NO_CRITERIA_REASON;
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
		condition:
			"the ## Campaigns table reads but does not parse — malformed, never 'nothing is active'",
	},
	{
		code: PRECONDITION_UNKNOWN,
		condition: "the campaigns table or the issue's home could not be read — admission is UNKNOWN",
	},
	{
		code: OUT_OF_SCOPE,
		condition:
			"proven: not admitted on the scope axis — the issue's home is pinned by no active campaign and no standing-lane label exempts it, or the target is a pull request naming no served issue to judge",
	},
	{
		code: TYPE_NOT_BUILDABLE,
		condition: `proven: not admitted on the type axis — the issue carries ${DECISION_TYPE_LABEL} or ${EPIC_TYPE_LABEL}, not one of ${BUILDABLE_TYPE_LABELS.join(" / ")}; reachable only under purpose build against an issue, and opened on a decision by --cites naming a founder ruling comment recorded on that issue`,
	},
	{
		code: AUDIENCE_NOT_AGENT,
		condition: `proven: not admitted on the audience axis — the issue's ${READY_FOR_PREFIX} label is not ${READY_FOR_AGENT}, or is absent; reachable only under purpose build, and never when an open PR serves a ${DECISION_TYPE_LABEL} issue`,
	},
	{
		code: NO_ACCEPTANCE_CRITERIA,
		condition:
			"proven: not admitted on the criteria axis — the body carries no readable ### Acceptance criteria block, absent or malformed; reachable only under purpose build against an issue",
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
export const dispatchScopeLine = (verb: string, dispatch: Dispatch): string => {
	switch (dispatch._tag) {
		case "Active": {
			const [only] = dispatch.campaigns;
			return dispatch.campaigns.length === 1
				? `${verb}: campaigns: 1 active — ${only.name} (#${only.milestone}).`
				: `${verb}: campaigns: ${dispatch.campaigns.length} active — ${dispatch.campaigns
						.map((row) => `${row.name} (#${row.milestone})`)
						.join(", ")}.`;
		}
		case "None":
			return `${verb}: campaigns: none active — scope fence inert.`;
		default:
			return `${verb}: campaigns: unreadable — ${dispatch.reason}.`;
	}
};

/** The `campaigns` field both seams report on the machine channel, beside the stderr scope line. */
export const dispatchReport = (
	dispatch: Dispatch,
):
	| {readonly state: "active"; readonly milestones: ReadonlyArray<string>}
	| {readonly state: "none"} =>
	dispatch._tag === "Active"
		? {state: "active", milestones: dispatch.campaigns.map((row) => String(row.milestone))}
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
		case "OutOfScope": {
			const home = admission.scope.home ?? "no milestone and no standing lane";
			return refuse(
				OUT_OF_SCOPE,
				`${verb}: out of scope — the active campaigns pin ${milestonePhrase(admission.scope.active)} and this issue's home is ${home}; flip that campaign's ## Campaigns state cell to active, or claim it with an explicit override.`,
			);
		}
		case "NoServedIssue":
			return refuse(
				OUT_OF_SCOPE,
				`${verb}: no served issue — the active campaigns pin ${milestonePhrase(admission.active)} and PR #${admission.pr} ${admission.reason}, so there is no ticket whose home the fence can judge; name the issue in the PR body (a closing keyword or "Part of #<n>"), or claim it with an explicit override.`,
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
		case "NoCriteria":
			return refuse(
				NO_ACCEPTANCE_CRITERIA,
				`${verb}: no acceptance criteria — ${admission.criteria.reason}, so there is no contract to build against and nothing downstream could grade a PR against one; ${
					admission.criteria.state === "absent"
						? "author the block with `fabrika triage enrich <n>` — an absent block has nothing to repair mechanically"
						: "straighten the heading with `fabrika triage repair-criteria <n>`, which repairs exactly this drift"
				}. The repair belongs on the issue, not on a branch, so no lane opens here.`,
			);
		default:
			return refuse(admission.code, `${verb}: ${admission.reason} — admission is UNKNOWN.`);
	}
};

/**
 * An input that could not be read, lifted into the composed outcome.
 *
 * Both the campaigns table and an issue's home come through here, so no seam ever seats `11` for
 * itself and no read failure can be talked into an `admitted`.
 */
export const unknownAdmission = (reason: string): Admission => ({
	_tag: "Unknown",
	code: PRECONDITION_UNKNOWN,
	reason,
});

/** A campaigns table read off disk, or the reason it could not be. */
export type DispatchRead =
	| {readonly _tag: "Read"; readonly dispatch: Dispatch}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const unreadable = (path: string, failure: ReadFailed): DispatchRead => ({
	_tag: "Unreadable",
	reason: `cannot read the campaigns table at ${path}: ${failure.reason}`,
});

/**
 * Read the campaigns table.
 *
 * An **absent file** and an absent section are the same well-formed default — nothing active — while
 * a file that is there and cannot be read is UNKNOWN. The probe is separate from the read for exactly
 * that split: a probe that cannot be performed is itself UNKNOWN, never "absent".
 */
export const readDispatch = (
	path: string,
): Effect.Effect<DispatchRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const probe = yield* Effect.result(exists(path));
		if (Result.isFailure(probe)) return unreadable(path, probe.failure);
		if (!probe.success) return {_tag: "Read" as const, dispatch: {_tag: "None" as const}};
		const read = yield* Effect.result(readFile(path));
		return Result.isFailure(read)
			? unreadable(path, read.failure)
			: {_tag: "Read" as const, dispatch: readCampaigns(read.success)};
	});

/**
 * The campaigns table at the roadmap file **this repo declares**, for a verb standing in a checkout.
 *
 * The two fence verbs read the roadmap through here rather than through {@link readDispatch}, whose
 * path argument they would otherwise fill from a literal. A config nobody can decode is `Unreadable`
 * exactly like a roadmap nobody can read: in both the fence is UNKNOWN, and the one thing it must
 * never become is "nothing is active", which admits every issue.
 */
export const readDeclaredDispatch = (
	cwd: string,
): Effect.Effect<DispatchRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const declared = yield* readRoadmapFile(cwd);
		return declared._tag === "Refused"
			? {
					_tag: "Unreadable" as const,
					reason: `${CONFIG_PATH} is refused — ${declared.reason.replace(/\.$/, "")}, so where the campaigns table lives is unread`,
				}
			: yield* readDispatch(declared.value);
	});
