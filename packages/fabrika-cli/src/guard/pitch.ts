/**
 * `guard pitch-guard check` — the decision: does every pickable piece of lane-entering work carry a
 * well-formed, founder-approved pitch?
 *
 * The invariant and the five-field set are defined once in `.glossary/TERMS.md` (§pitch, a founder
 * ruling); this module is that contract's teeth, not a second definition of it.
 *
 * The guard binds at INTAKE only. Its inverse is half the same ruling: no merge-blocking
 * conformance gate on shipped work, so nothing here may ever be wired to red a PR.
 *
 * IO-free and total; the board read lives in `./pitch-verb.ts`.
 */

import {
	type AppetiteSizes,
	describeSizes,
	SIZES,
	type Size,
} from "../config/keys/appetite-sizes.ts";
import type {LabelUniverse} from "./label-universe.ts";
import {clean, type GuardVerdict, unknown, violation, zeroScope} from "./verdict.ts";

export const VERB = "guard pitch-guard check";

/** The label that puts an issue in scope: the requirement binds when triage makes it pickable. */
export const TRIAGED_LABEL = "status:triaged";

/**
 * Lane-entering work, exactly: an epic is a bet, and so is a standalone feature. A `type:feature`
 * WITH a parent inherits its epic's pitch — that check lives in {@link isLaneEntering}. Maintenance
 * and questions (`type:bug` / `type:chore` / `type:decision` / `type:investigation`) are not bets.
 * Widening this set is a founder call, so it is a frozen literal rather than a config surface.
 */
export const LANE_ENTERING_TYPES: ReadonlyArray<string> = ["type:epic", "type:feature"];

/** The labels an issue-scope check needs before an empty result may read as "out of scope". */
export const SCOPE_LABELS: ReadonlyArray<string> = [TRIAGED_LABEL, ...LANE_ENTERING_TYPES];

/** The five fields, in canonical order. All are required; a missing one is a malformed pitch. */
export const PITCH_FIELDS = ["Problem", "Arc", "Appetite", "Rabbit-holes", "No-gos"] as const;
export type PitchField = (typeof PITCH_FIELDS)[number];

/**
 * The optional sixth line: the one sentence the two-week check judges the shipped bet against. A
 * pitch without it is still well-formed.
 */
export const SUCCESS_FIELD = "Success";
type ReadableField = PitchField | typeof SUCCESS_FIELD;

/** One comment reduced to what the approval rule reads. */
export interface Comment {
	readonly author: string;
	/** Resolved at the GitHub ACL by the IO shell — `write+` only, fail-closed. */
	readonly authorized: boolean;
	readonly body: string;
}

/** One candidate issue reduced to the facts the invariant reads. */
export interface Candidate {
	readonly number: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
	/** True when the issue is a sub-issue — it inherits its epic's pitch and needs none. */
	readonly hasParent: boolean;
	readonly body: string;
	readonly comments: ReadonlyArray<Comment>;
}

/**
 * What the guard scanned. `backlog` is the whole open lane-entering `status:triaged` set; `issue` is
 * the per-issue seam check that fires the moment triage stamps the label.
 *
 * Issue scope carries the label `universe` for the same reason `homing-guard`'s does: an empty issue
 * scope reads either "not lane-entering work" or "this repo has none of the scoping labels", and
 * only the label universe separates them.
 */
export type Scope =
	| {readonly _tag: "backlog"}
	| {readonly _tag: "issue"; readonly number: number; readonly universe: LabelUniverse};

const heading = /^\s{0,3}#{2,6}\s*pitch\s*$/i;
const anyHeading = /^\s{0,3}#{1,6}\s/;

/**
 * The `## Pitch` section body — heading to the next heading of any level. Scoping field extraction
 * to this section is what keeps a plan-epic body's `### Problem & who has it` from reading as a
 * pitch field.
 */
export const pitchSection = (body: string): string | null => {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => anyHeading.test(line));
	return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

// Tolerant read: optional bold/italic markers, any case, and `Rabbit holes` reads as `Rabbit-holes`.
// Field order is not load-bearing.
//
// HORIZONTAL whitespace only (`[ \t]`), never `\s`: `\s` matches the newline, so a field left empty
// (`**Arc:**`) would swallow the line break and capture the NEXT field's value as its own — a blank
// field silently reading as filled, which is the one miss a fail-closed guard cannot afford.
const fieldPattern = (field: ReadableField): RegExp =>
	new RegExp(
		`^[ \\t]*[*_]{0,2}[ \\t]*${field.replace("-", "[- ]")}[ \\t]*[*_]{0,2}[ \\t]*:[ \\t]*[*_]{0,2}[ \\t]*(.*)$`,
		"im",
	);

export const readField = (section: string, field: ReadableField): string | null => {
	const value = fieldPattern(field)
		.exec(section)?.[1]
		?.replace(/[*_\s]+$/, "")
		.trim();
	return value ? value : null;
};

/**
 * A pitch's appetite: a dollar size, or the legacy whole number of 2-week cycles every pitch written
 * before sizes still carries. Both are budgets, never duration estimates.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */
export type Appetite =
	| {readonly _tag: "size"; readonly size: Size}
	| {readonly _tag: "cycles"; readonly cycles: number};

/** The legacy arm: a whole positive number of 2-week cycles. */
export const parseAppetiteCycles = (value: string): number | null => {
	const digits = /^(\d+)\s*cycles?\b/i.exec(value.trim())?.[1];
	if (digits === undefined) return null;
	const cycles = Number.parseInt(digits, 10);
	return cycles > 0 ? cycles : null;
};

// Upper-case only, and the letter must stand alone: `M ($35)` is a size, `Medium` and `m` are not.
const SIZE_LEAD = /^([SML])(?![\w-])/;

export const parseAppetite = (value: string): Appetite | null => {
	const size = SIZE_LEAD.exec(value.trim())?.[1] as Size | undefined;
	if (size !== undefined) return {_tag: "size", size};
	const cycles = parseAppetiteCycles(value);
	return cycles === null ? null : {_tag: "cycles", cycles};
};

export const sameAppetite = (a: Appetite, b: Appetite): boolean =>
	a._tag === "size"
		? b._tag === "size" && a.size === b.size
		: b._tag === "cycles" && a.cycles === b.cycles;

/** `M`, or `2 cycles` — the appetite as a pitch writes it. */
export const describeAppetite = (appetite: Appetite): string =>
	appetite._tag === "size" ? appetite.size : `${appetite.cycles} cycles`;

export type PitchRead =
	| {readonly _tag: "absent"}
	| {readonly _tag: "malformed"; readonly missing: ReadonlyArray<string>}
	| {
			readonly _tag: "present";
			readonly appetite: Appetite;
			/** The optional `**Success:**` sentence, or `null` when the pitch names none. */
			readonly success: string | null;
	  };

export const readPitch = (body: string): PitchRead => {
	const section = pitchSection(body);
	if (section === null) return {_tag: "absent"};

	const missing: Array<string> = [];
	let appetite: Appetite | null = null;
	for (const field of PITCH_FIELDS) {
		const value = readField(section, field);
		if (value === null) {
			missing.push(field);
			continue;
		}
		if (field === "Appetite") {
			appetite = parseAppetite(value);
			if (appetite === null) {
				missing.push(`Appetite (not a size ${SIZES.join(" / ")}, nor a whole number of cycles)`);
			}
		}
	}
	if (missing.length > 0 || appetite === null) return {_tag: "malformed", missing};
	return {_tag: "present", appetite, success: readField(section, SUCCESS_FIELD)};
};

/** The approval marker: emphasis-tolerant, appetite-capturing. */
export const APPROVAL_RE = /^\s*[*_]{0,2}\s*pitch-approved\s*[*_]{0,2}\s*:\s*(.*)$/im;
const APPETITE_IN_MARKER = /appetite\s+(?:([SML])(?![\w-])|(\d+)\s*cycles?\b)/i;

/**
 * The agent-provenance tells — the pipeline's provenance signal, applied to approval.
 *
 * GitHub authorship cannot separate founder from agent — both write through one shared token, the
 * same degeneracy the claim marker works around — so the tell is the STAMP. Every agent-posted
 * pipeline comment is provenance-stamped and no agent has a `pitch-approved:` write path, so a
 * stamped marker is by construction not an approval.
 */
export const AGENT_STAMP_RES: ReadonlyArray<RegExp> = [
	/filed by an agent/i,
	/\bsession\b[^\n]{0,40}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	/^\s*claim\s*:/im,
];

export const isAgentStamped = (body: string): boolean =>
	AGENT_STAMP_RES.some((stamp) => stamp.test(body));

export type Approval =
	| {readonly _tag: "approved"; readonly appetite: Appetite}
	| {readonly _tag: "none"}
	| {readonly _tag: "unauthorized"}
	| {readonly _tag: "agent-authored"}
	| {readonly _tag: "malformed-marker"}
	| {
			readonly _tag: "appetite-mismatch";
			readonly approved: Appetite;
			readonly declared: Appetite;
	  };

/** The appetite a marker's text binds, or `null` when it names none. */
const markerAppetite = (rest: string): Appetite | null => {
	const match = APPETITE_IN_MARKER.exec(rest);
	if (match === null) return null;
	const [, size, cycles] = match;
	// The flag is there for the legacy `Cycles`; a size is upper-case only, exactly as the body reads it.
	if (size !== undefined) {
		return (SIZES as ReadonlyArray<string>).includes(size)
			? {_tag: "size", size: size as Size}
			: null;
	}
	const count = Number.parseInt(cycles ?? "", 10);
	return count > 0 ? {_tag: "cycles", cycles: count} : null;
};

/**
 * Resolve the approval against the appetite the body declares. Fail-closed and ordered so the report
 * names the nearest miss: an unauthorized-only marker never silently reads as absent, and an
 * agent-stamped marker never reads as the founder's.
 */
export const resolveApproval = (comments: ReadonlyArray<Comment>, declared: Appetite): Approval => {
	const markers = comments.filter((comment) => APPROVAL_RE.test(comment.body));
	if (markers.length === 0) return {_tag: "none"};

	let sawUnauthorized = false;
	let sawAgent = false;
	let sawMalformed = false;
	let mismatch: Appetite | null = null;
	for (const marker of markers) {
		if (!marker.authorized) {
			sawUnauthorized = true;
			continue;
		}
		if (isAgentStamped(marker.body)) {
			sawAgent = true;
			continue;
		}
		const rest = APPROVAL_RE.exec(marker.body)?.[1] ?? "";
		const approved = markerAppetite(rest);
		if (approved === null) {
			sawMalformed = true;
			continue;
		}
		if (!sameAppetite(approved, declared)) {
			mismatch = approved;
			continue;
		}
		return {_tag: "approved", appetite: approved};
	}
	if (mismatch !== null) return {_tag: "appetite-mismatch", approved: mismatch, declared};
	if (sawMalformed) return {_tag: "malformed-marker"};
	if (sawAgent) return {_tag: "agent-authored"};
	if (sawUnauthorized) return {_tag: "unauthorized"};
	return {_tag: "none"};
};

/**
 * The appetite a `bet` row's head states in its own `## Pitch`. A group row's Size approves its
 * members only through this: the Size must equal an appetite a pitch body wrote.
 */
export type HeadAppetite =
	| {readonly _tag: "stated"; readonly appetite: Appetite}
	/** The head carries no well-formed pitch, so no written appetite backs the row's Size. */
	| {readonly _tag: "unstated"}
	| {readonly _tag: "unread"; readonly reason: string};

/** What a head body's pitch states. */
export const headAppetiteOf = (body: string): HeadAppetite => {
	const read = readPitch(body);
	return read._tag === "present" ? {_tag: "stated", appetite: read.appetite} : {_tag: "unstated"};
};

/**
 * One `bet` row on the table, the second approval carrier. The row approves the pitch of every issue
 * in `covers`: its head, and for an epic or chain row every member.
 *
 * Authority is the Stage value's setter at `write+`, the bar a `pitch-approved:` author meets. A
 * field value carries no provenance stamp, so a `bet` an agent sets under the founder's `write+`
 * token counts as the founder's approval: agents set `bet` only on his instruction. The approval
 * binds the appetite a pitch body states. The Size cell must match it and never stands in for it,
 * since nothing checks who set the Size.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9913
 */
export interface BetRow {
	readonly head: number;
	/** The head first, then every member of a group row. */
	readonly covers: ReadonlyArray<number>;
	/** The row's Size cell as set, or `null` when it is empty. */
	readonly size: string | null;
	/** What the head's own pitch states, read off the head's body by the IO shell. */
	readonly headAppetite: HeadAppetite;
	/** Who set the Stage to `bet`, or `null` when GitHub names no actor. */
	readonly setter: string | null;
	/** Resolved at the GitHub ACL by the IO shell — `write+` only, fail-closed. */
	readonly authorized: boolean;
}

/** The table as the bet arm read it. An unread table approves nothing; comments alone decide. */
export type BetTable =
	| {readonly _tag: "read"; readonly source: string; readonly rows: ReadonlyArray<BetRow>}
	| {readonly _tag: "unread"; readonly reason: string};

export const TABLE_NOT_CONSULTED: BetTable = {_tag: "unread", reason: "no table was consulted"};

export type BetApproval =
	| {readonly _tag: "approved"; readonly row: BetRow}
	| {readonly _tag: "unread"}
	| {readonly _tag: "none"}
	| {readonly _tag: "cycles-pitch"; readonly head: number}
	| {readonly _tag: "unauthorized"; readonly head: number; readonly setter: string | null}
	| {readonly _tag: "no-size"; readonly head: number}
	/** The member's group row has a Size that no appetite written on its head backs. */
	| {readonly _tag: "group-unbacked"; readonly head: number; readonly why: string}
	| {
			readonly _tag: "size-mismatch";
			readonly head: number;
			readonly size: Size;
			readonly declared: Size;
	  };

const sizeOf = (cell: string | null): Size | null =>
	cell !== null && (SIZES as ReadonlyArray<string>).includes(cell) ? (cell as Size) : null;

/** Why a group row's Size is not an appetite its head's pitch wrote, or `null` when it is. */
const unbackedBy = (row: BetRow, size: Size): string | null => {
	const stated = row.headAppetite;
	switch (stated._tag) {
		case "unread":
			return `its head's pitch could not be read (${stated.reason})`;
		case "unstated":
			return `its head #${row.head} carries no well-formed pitch`;
		case "stated":
			if (stated.appetite._tag === "cycles") {
				return `its head #${row.head} states a legacy \`${describeAppetite(stated.appetite)}\` appetite`;
			}
			return stated.appetite.size === size
				? null
				: `it is sized ${size} but its head #${row.head} declares ${stated.appetite.size}`;
	}
};

/**
 * Resolve the bet arm for one issue. A row binds its size on its head: the row's Size must equal the
 * size the head's pitch declares. A member of a group row is approved whatever its own appetite, but
 * only while the row's Size equals the size its head's pitch declares, so the Size cell never stands
 * in for an appetite no pitch wrote. Ordered like {@link resolveApproval}, so the report names the
 * nearest miss.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9856
 * @ruling https://github.com/kamp-us/phoenix/issues/9913
 */
export const resolveBetApproval = (
	issue: number,
	table: BetTable,
	declared: Appetite,
): BetApproval => {
	if (table._tag === "unread") return {_tag: "unread"};
	const rows = table.rows.filter((row) => row.covers.includes(issue));
	if (rows.length === 0) return {_tag: "none"};

	let unauthorized: BetRow | null = null;
	let unsized: BetRow | null = null;
	let legacy: BetRow | null = null;
	let unbacked: {readonly row: BetRow; readonly why: string} | null = null;
	let mismatch: {readonly row: BetRow; readonly size: Size; readonly declared: Size} | null = null;
	for (const row of rows) {
		if (!row.authorized) {
			unauthorized ??= row;
			continue;
		}
		const size = sizeOf(row.size);
		if (size === null) {
			unsized ??= row;
			continue;
		}
		if (row.head !== issue) {
			const why = unbackedBy(row, size);
			if (why === null) return {_tag: "approved", row};
			unbacked ??= {row, why};
			continue;
		}
		if (declared._tag === "cycles") {
			legacy ??= row;
			continue;
		}
		if (size !== declared.size) {
			mismatch ??= {row, size, declared: declared.size};
			continue;
		}
		return {_tag: "approved", row};
	}
	if (mismatch !== null) {
		return {
			_tag: "size-mismatch",
			head: mismatch.row.head,
			size: mismatch.size,
			declared: mismatch.declared,
		};
	}
	if (unbacked !== null) {
		return {_tag: "group-unbacked", head: unbacked.row.head, why: unbacked.why};
	}
	if (legacy !== null) return {_tag: "cycles-pitch", head: legacy.head};
	if (unsized !== null) return {_tag: "no-size", head: unsized.head};
	if (unauthorized !== null) {
		return {_tag: "unauthorized", head: unauthorized.head, setter: unauthorized.setter};
	}
	return {_tag: "none"};
};

/** Why the bet arm did not approve, or `null` when the table was unread (the run names that once). */
const betDetail = (approval: Exclude<BetApproval, {_tag: "approved"}>): string | null => {
	switch (approval._tag) {
		case "unread":
			return null;
		case "none":
			return "no `bet` row on the table covers it";
		case "cycles-pitch":
			return `its \`bet\` row #${approval.head} cannot approve a legacy \`<N> cycles\` pitch — that still needs its \`pitch-approved:\` comment`;
		case "unauthorized":
			return `its \`bet\` row #${approval.head} was set by ${approval.setter ?? "an account GitHub no longer names"}, not a write+ collaborator`;
		case "no-size":
			return `its \`bet\` row #${approval.head} names no Size ${SIZES.join(" / ")}`;
		case "group-unbacked":
			return `its group \`bet\` row #${approval.head} approves no member: ${approval.why} — the row's Size must equal the size its head's pitch declares`;
		case "size-mismatch":
			return `its \`bet\` row #${approval.head} is sized ${approval.size} but the body declares ${approval.declared} — re-approval needed: set the row's Size to ${approval.declared}, or re-pitch`;
	}
};

/** The bet arm's one line for the report: what was read, or why nothing was. */
export const describeBetTable = (table: BetTable): string =>
	table._tag === "read"
		? `pitch-guard: bet arm read the table ${table.source} — ${table.rows.length} \`bet\` row(s).`
		: `pitch-guard: bet arm unread — ${table.reason}; approval was decided from \`pitch-approved:\` comments alone.`;

/** Lane-entering: an epic, or a parentless feature; triaged in both cases. */
export const isLaneEntering = (candidate: Candidate): boolean => {
	if (!candidate.labels.includes(TRIAGED_LABEL)) return false;
	if (candidate.labels.includes("type:epic")) return true;
	return candidate.labels.includes("type:feature") && !candidate.hasParent;
};

export type Disposition =
	| {readonly _tag: "out-of-scope"}
	| {readonly _tag: "pitched"; readonly appetite: Appetite}
	| {readonly _tag: "unpitched"; readonly detail: string};

const APPROVAL_DETAIL: {
	readonly [K in Exclude<Approval["_tag"], "approved" | "appetite-mismatch">]: string;
} = {
	none: "carries a well-formed pitch but no founder `pitch-approved:` comment — awaiting the founder",
	unauthorized: "its only `pitch-approved:` comment is not from a write+ collaborator",
	"agent-authored":
		"its only `pitch-approved:` comment is agent-provenance-stamped — approval is a founder seat, never agent-satisfiable",
	"malformed-marker":
		"its `pitch-approved:` comment names no `appetite <S|M|L>` (or legacy `appetite <N> cycles`) — approval must bind the appetite it approved",
};

const commentDetail = (approval: Exclude<Approval, {_tag: "approved"}>): string =>
	approval._tag === "appetite-mismatch"
		? `its approval names appetite ${describeAppetite(approval.approved)} but the body declares ${describeAppetite(approval.declared)} — re-approval needed`
		: APPROVAL_DETAIL[approval._tag];

/** Either carrier approves: a `pitch-approved:` comment, or a `bet` row on the table. */
export const disposition = (
	candidate: Candidate,
	table: BetTable = TABLE_NOT_CONSULTED,
): Disposition => {
	if (!isLaneEntering(candidate)) return {_tag: "out-of-scope"};

	const read = readPitch(candidate.body);
	if (read._tag === "absent") return {_tag: "unpitched", detail: "has no `## Pitch` section"};
	if (read._tag === "malformed") {
		return {
			_tag: "unpitched",
			detail: `its \`## Pitch\` section is missing: ${read.missing.join(", ")}`,
		};
	}

	const approval = resolveApproval(candidate.comments, read.appetite);
	if (approval._tag === "approved") return {_tag: "pitched", appetite: approval.appetite};
	const bet = resolveBetApproval(candidate.number, table, read.appetite);
	if (bet._tag === "approved") return {_tag: "pitched", appetite: read.appetite};
	const onTable = betDetail(bet);
	const detail = commentDetail(approval);
	return {_tag: "unpitched", detail: onTable === null ? detail : `${detail}; and ${onTable}`};
};

export interface Unpitched {
	readonly number: number;
	readonly title: string;
	readonly detail: string;
}

export type PitchVerdict =
	| {
			readonly pass: true;
			readonly scope: Scope;
			readonly scanned: number;
			readonly pitched: number;
	  }
	/** No lane-entering work in scope — fail closed, never a vacuous pass. */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly scope: Scope}
	/** The labels that define scope do not exist in the repo at all — unmet prerequisite. */
	| {
			readonly pass: false;
			readonly reason: "vocabulary-absent";
			readonly scope: Scope;
			readonly missing: ReadonlyArray<string>;
	  }
	| {
			readonly pass: false;
			readonly reason: "unpitched";
			readonly scope: Scope;
			readonly scanned: number;
			readonly pitched: number;
			readonly unpitched: ReadonlyArray<Unpitched>;
	  };

/**
 * Judge the scanned set.
 *
 * Zero scope forks on what was scanned, exactly as `homing-guard` forks it. Over the whole
 * **backlog** an empty lane-entering set is indistinguishable from a broken query (a renamed label, a
 * lost token, a wrong repo) — the silent no-op every guard here fails closed on. Over a single **issue**
 * empty is the ordinary answer "that issue is not lane-entering work", so it passes — but only where
 * the scoping labels exist. Where they do not, every issue takes that fork and the guard reports
 * clean forever, having checked nothing.
 */
export const judge = (
	candidates: ReadonlyArray<Candidate>,
	scope: Scope = {_tag: "backlog"},
	table: BetTable = TABLE_NOT_CONSULTED,
): PitchVerdict => {
	const inScope = candidates.filter(isLaneEntering);
	if (inScope.length === 0) {
		if (scope._tag === "backlog") return {pass: false, reason: "zero-scope", scope};
		return scope.universe._tag === "absent"
			? {pass: false, reason: "vocabulary-absent", scope, missing: scope.universe.missing}
			: {pass: true, scope, scanned: 0, pitched: 0};
	}

	const unpitched: Array<Unpitched> = [];
	let pitched = 0;
	for (const candidate of inScope) {
		const resolved = disposition(candidate, table);
		if (resolved._tag === "pitched") pitched++;
		else if (resolved._tag === "unpitched") {
			unpitched.push({number: candidate.number, title: candidate.title, detail: resolved.detail});
		}
	}

	if (unpitched.length > 0) {
		return {pass: false, reason: "unpitched", scope, scanned: inScope.length, pitched, unpitched};
	}
	return {pass: true, scope, scanned: inScope.length, pitched};
};

const scopeLabel = (scope: Scope): string =>
	scope._tag === "backlog"
		? "the open status:triaged lane-entering backlog"
		: `issue #${scope.number}`;

/** The remediation, stated once — the draft/approve split is the whole point. */
const remedy = (sizes: AppetiteSizes): string =>
	"Each issue above is pickable lane-entering work with no founder-approved pitch. Direction binds\n" +
	"at intake (a founder ruling); see §pitch in .glossary/TERMS.md:\n" +
	`  1. triage DRAFTS a ## Pitch section with all five fields (${PITCH_FIELDS.join(" / ")}),\n` +
	"     where Arc restates the home the triage rubric already assigned, Appetite is a size\n" +
	`     ${SIZES.join(" / ")} (${describeSizes(sizes)} per epic child), and an optional\n` +
	"     Success line names what the two-week check judges;\n" +
	"  2. the FOUNDER approves it, either way:\n" +
	"     - a `bet` on the table: its row's Stage set to `bet` with a Size equal to the body's size.\n" +
	"       A `bet` on an epic or chain row approves the head and every member, while the row's Size\n" +
	"       equals the head's. The Stage must be set by a write+ collaborator, or by an agent under\n" +
	"       the founder's token on his say-so;\n" +
	"     - or a `pitch-approved: appetite <S|M|L> · <ISO-8601-UTC>` comment naming the same size the\n" +
	"       body declares (a legacy `<N> cycles` pitch approves only this way, as\n" +
	"       `appetite <N> cycles`). An agent never posts this comment.";

/** Render the report for a verdict — always emit what you scanned, never a bare all-clear. */
export const renderReport = (verdict: PitchVerdict, sizes: AppetiteSizes): string => {
	if (verdict.pass) {
		if (verdict.scanned === 0) {
			return `pitch-guard: ${scopeLabel(verdict.scope)} is not lane-entering work — out of scope, nothing to check.`;
		}
		return (
			`pitch-guard: ${scopeLabel(verdict.scope)} is fully pitched — scanned ${verdict.scanned} ` +
			`lane-entering issue(s), ${verdict.pitched} carrying a founder-approved pitch, 0 unpitched.`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`pitch-guard: scanned ${scopeLabel(verdict.scope)} and found ZERO lane-entering issues — ` +
			"fail-closed, like every guard here. An empty set is indistinguishable from a broken read " +
			"(renamed label, missing token, wrong repo), and a vacuous pass would hide every unpitched bet."
		);
	}
	if (verdict.reason === "vocabulary-absent") {
		return (
			`pitch-guard: ${scopeLabel(verdict.scope)} is not lane-entering work, but the label(s) that ` +
			`define scope do not exist in this repo at all: ${verdict.missing.join(", ")} — unmet ` +
			"prerequisite, not an out-of-scope issue. Create the missing labels; adopting the " +
			"pipeline means adopting its taxonomy."
		);
	}
	const lines = verdict.unpitched.map(
		(one) => `  #${one.number} ${one.title}\n      ${one.detail}`,
	);
	return (
		`pitch-guard: ${verdict.unpitched.length} of ${verdict.scanned} lane-entering issue(s) in ` +
		`${scopeLabel(verdict.scope)} are pickable without a founder-approved pitch ` +
		`(${verdict.pitched} pitched):\n${lines.join("\n")}\n\n${remedy(sizes)}`
	);
};

export const toGuardVerdict = (verdict: PitchVerdict, sizes: AppetiteSizes): GuardVerdict => {
	const report = renderReport(verdict, sizes);
	if (verdict.pass) {
		return clean(report, verdict.scope._tag === "issue" ? 1 : verdict.scanned);
	}
	switch (verdict.reason) {
		case "zero-scope":
			return zeroScope(report);
		case "vocabulary-absent":
			return unknown(report);
		case "unpitched":
			return violation(report);
	}
};
