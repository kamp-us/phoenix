/**
 * `pitch-guard` pure core — decide whether every pickable piece of lane-entering work carries
 * a well-formed, founder-approved pitch. The invariant and the field set come from the §PITCH
 * intake format (founder ruling #3909); its v1 skill-doc home retired with the kampus-pipeline
 * plugin (ADR 0291), so this module now carries the field set. IO-free and total — the
 * `gh api` reads live in `github.ts`/`gate.ts`.
 *
 * The guard binds at INTAKE only. Its inverse is half the founder ruling: no merge-blocking
 * conformance gate on shipped work, so nothing here may ever be wired to red a PR (#3909).
 *
 * Deliberately NOT encoded here: park / expiry semantics, and any reading of ADR 0072 §4. The
 * park carrier is defined once by the appetite-circuit-breaker child #3966, and that question
 * is open — a pitch field never implies an answer to it.
 */
import type {VocabularyPresence} from "../vocabulary-preflight/presence.ts";

/** The label that puts an issue in scope: the requirement binds when triage makes it pickable. */
export const TRIAGED_LABEL = "status:triaged";

/**
 * Lane-entering work, exactly (§PITCH Scope): an epic is a bet, and so is a standalone build
 * feature. A `type:feature` WITH a parent inherits its epic's pitch — the parent check lives in
 * `isLaneEntering`, not here. Maintenance and questions (`type:bug` / `type:chore` /
 * `type:decision` / `type:investigation`) are not bets and carry no pitch. Widening this set is a
 * founder call, so it is a frozen literal rather than a config surface.
 */
export const LANE_ENTERING_TYPES: ReadonlyArray<string> = ["type:epic", "type:feature"];

/** The five fields, in canonical order. All are required; a missing one is a malformed pitch. */
export const PITCH_FIELDS = ["Problem", "Arc", "Appetite", "Rabbit-holes", "No-gos"] as const;
export type PitchField = (typeof PITCH_FIELDS)[number];

/** One comment reduced to what the approval rule reads. */
export interface Comment {
	readonly author: string;
	/** Resolved at the GitHub ACL by the IO shell — `write+` only, fail-closed (ADR 0055). */
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
 * Issue scope carries the label universe's `vocabulary` for the same reason `homing-guard`'s
 * does: an empty issue scope reads either "not lane-entering work" or "this repo has none of the
 * scoping labels", and only the label universe separates them (#4272).
 */
export type Scope =
	| {readonly _tag: "backlog"}
	| {
			readonly _tag: "issue";
			readonly number: number;
			readonly vocabulary: VocabularyPresence;
	  };

const heading = /^\s{0,3}#{2,6}\s*pitch\s*$/i;
const anyHeading = /^\s{0,3}#{1,6}\s/;

/**
 * Extract the `## Pitch` section body — the text from the heading to the next heading of any
 * level. Scoping field extraction to this section is what keeps a plan-epic body's
 * `### Problem & who has it` from reading as a pitch field.
 */
export const pitchSection = (body: string): string | null => {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((l) => heading.test(l));
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => anyHeading.test(l));
	return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

// Tolerant read (§Reading stance): optional bold/italic markers, any case, and `Rabbit holes`
// reads as `Rabbit-holes`. Field order is not load-bearing.
//
// HORIZONTAL whitespace only (`[ \t]`), never `\s`: `\s` matches the newline, so a field left
// empty (`**Arc:**`) would swallow the line break and capture the NEXT field's value as its own —
// a blank field silently reading as filled, which is the one miss a fail-closed guard cannot
// afford.
const fieldPattern = (field: PitchField): RegExp =>
	new RegExp(
		`^[ \\t]*[*_]{0,2}[ \\t]*${field.replace("-", "[- ]")}[ \\t]*[*_]{0,2}[ \\t]*:[ \\t]*[*_]{0,2}[ \\t]*(.*)$`,
		"im",
	);

export const readField = (section: string, field: PitchField): string | null => {
	const value = fieldPattern(field)
		.exec(section)?.[1]
		?.replace(/[*_\s]+$/, "")
		.trim();
	return value ? value : null;
};

/** Appetite is a whole positive number of 2-week cycles — a budget, never a duration estimate. */
export const parseAppetiteCycles = (value: string): number | null => {
	const n = /^(\d+)\s*cycles?\b/i.exec(value.trim())?.[1];
	if (n === undefined) return null;
	const cycles = Number.parseInt(n, 10);
	return cycles > 0 ? cycles : null;
};

export interface Pitch {
	readonly appetiteCycles: number;
}

export type PitchRead =
	| {readonly _tag: "absent"}
	| {readonly _tag: "malformed"; readonly missing: ReadonlyArray<string>}
	| {readonly _tag: "present"; readonly pitch: Pitch};

export const readPitch = (body: string): PitchRead => {
	const section = pitchSection(body);
	if (section === null) return {_tag: "absent"};

	const missing: Array<string> = [];
	let appetiteCycles: number | null = null;
	for (const field of PITCH_FIELDS) {
		const value = readField(section, field);
		if (value === null) {
			missing.push(field);
			continue;
		}
		if (field === "Appetite") {
			appetiteCycles = parseAppetiteCycles(value);
			if (appetiteCycles === null) missing.push("Appetite (not a whole number of cycles)");
		}
	}
	if (missing.length > 0 || appetiteCycles === null) return {_tag: "malformed", missing};
	return {_tag: "present", pitch: {appetiteCycles}};
};

/** The approval marker: emphasis-tolerant, appetite-capturing (§PITCH). */
export const APPROVAL_RE = /^\s*[*_]{0,2}\s*pitch-approved\s*[*_]{0,2}\s*:\s*(.*)$/im;
const APPETITE_IN_MARKER = /appetite\s+(\d+)\s*cycles?\b/i;

/**
 * The agent-provenance tells (§PITCH clause 2, applying the §4.5 / ADR 0159 signal to approval).
 *
 * GitHub authorship cannot separate founder from agent — both write through the shared `usirin`
 * token, the same degeneracy ADR 0115 removes for the claim marker — so the tell is the STAMP.
 * Every agent-posted pipeline comment is provenance-stamped and no agent has a `pitch-approved:`
 * write path, so a stamped marker is by construction not an approval.
 */
export const AGENT_STAMP_RES: ReadonlyArray<RegExp> = [
	/filed by an agent/i,
	/\bsession\b[^\n]{0,40}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	/^\s*claim\s*:/im,
];

export const isAgentStamped = (body: string): boolean =>
	AGENT_STAMP_RES.some((re) => re.test(body));

export type Approval =
	| {readonly _tag: "approved"; readonly cycles: number}
	| {readonly _tag: "none"}
	| {readonly _tag: "unauthorized"}
	| {readonly _tag: "agent-authored"}
	| {readonly _tag: "malformed-marker"}
	| {readonly _tag: "appetite-mismatch"; readonly approved: number; readonly declared: number};

/**
 * Resolve the approval against the appetite the body declares. Fail-closed and ordered so the
 * report names the nearest miss: an unauthorized-only marker never silently reads as absent, and
 * an agent-stamped marker never reads as the founder's.
 */
export const resolveApproval = (
	comments: ReadonlyArray<Comment>,
	declaredCycles: number,
): Approval => {
	const markers = comments.filter((c) => APPROVAL_RE.test(c.body));
	if (markers.length === 0) return {_tag: "none"};

	let sawUnauthorized = false;
	let sawAgent = false;
	let sawMalformed = false;
	let mismatch: number | null = null;
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
		const cycles = APPETITE_IN_MARKER.exec(rest)?.[1];
		if (cycles === undefined) {
			sawMalformed = true;
			continue;
		}
		const approved = Number.parseInt(cycles, 10);
		if (approved !== declaredCycles) {
			mismatch = approved;
			continue;
		}
		return {_tag: "approved", cycles: approved};
	}
	if (mismatch !== null) {
		return {_tag: "appetite-mismatch", approved: mismatch, declared: declaredCycles};
	}
	if (sawMalformed) return {_tag: "malformed-marker"};
	if (sawAgent) return {_tag: "agent-authored"};
	if (sawUnauthorized) return {_tag: "unauthorized"};
	return {_tag: "none"};
};

/** Lane-entering per §PITCH Scope: an epic, or a parentless feature; triaged in both cases. */
export const isLaneEntering = (candidate: Candidate): boolean => {
	if (!candidate.labels.includes(TRIAGED_LABEL)) return false;
	if (candidate.labels.includes("type:epic")) return true;
	return candidate.labels.includes("type:feature") && !candidate.hasParent;
};

export type Disposition =
	| {readonly _tag: "out-of-scope"}
	| {readonly _tag: "pitched"; readonly cycles: number}
	| {readonly _tag: "unpitched"; readonly detail: string};

const APPROVAL_DETAIL: {
	readonly [K in Exclude<Approval["_tag"], "approved" | "appetite-mismatch">]: string;
} = {
	none: "carries a well-formed pitch but no founder `pitch-approved:` comment — awaiting the founder",
	unauthorized: "its only `pitch-approved:` comment is not from a write+ collaborator (ADR 0055)",
	"agent-authored":
		"its only `pitch-approved:` comment is agent-provenance-stamped — approval is a founder seat, never agent-satisfiable",
	"malformed-marker":
		"its `pitch-approved:` comment names no `appetite <N> cycles` — approval must bind the number it approved",
};

export const disposition = (candidate: Candidate): Disposition => {
	if (!isLaneEntering(candidate)) return {_tag: "out-of-scope"};

	const read = readPitch(candidate.body);
	if (read._tag === "absent") {
		return {_tag: "unpitched", detail: "has no `## Pitch` section"};
	}
	if (read._tag === "malformed") {
		return {
			_tag: "unpitched",
			detail: "its `## Pitch` section is missing: " + read.missing.join(", "),
		};
	}

	const approval = resolveApproval(candidate.comments, read.pitch.appetiteCycles);
	if (approval._tag === "approved") return {_tag: "pitched", cycles: approval.cycles};
	if (approval._tag === "appetite-mismatch") {
		return {
			_tag: "unpitched",
			detail: `its approval names appetite ${approval.approved} cycles but the body declares ${approval.declared} — re-approval needed`,
		};
	}
	return {_tag: "unpitched", detail: APPROVAL_DETAIL[approval._tag]};
};

export interface Unpitched {
	readonly number: number;
	readonly title: string;
	readonly detail: string;
}

export type PitchGuardVerdict =
	| {
			readonly pass: true;
			readonly scope: Scope;
			readonly scanned: number;
			readonly pitched: number;
	  }
	/** No lane-entering work in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly scope: Scope}
	/** The labels that define scope do not exist in the repo at all — unmet prerequisite (#4272). */
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
 * **backlog** an empty lane-entering set is indistinguishable from a broken query (a renamed
 * label, a lost token, a wrong repo) — the silent no-op ADR 0092 makes fail closed. Over a
 * single **issue** empty is the ordinary answer "that issue is not lane-entering work", so it
 * passes; the caller hands an out-of-scope issue through as an empty set — but only when the
 * scoping labels exist. Where they do not, every issue takes that fork and the guard reports
 * clean forever, having checked nothing (#4272).
 */
export const judge = (
	candidates: ReadonlyArray<Candidate>,
	scope: Scope = {_tag: "backlog"},
): PitchGuardVerdict => {
	const inScope = candidates.filter((c) => isLaneEntering(c));
	if (inScope.length === 0) {
		if (scope._tag === "backlog") return {pass: false, reason: "zero-scope", scope};
		return scope.vocabulary._tag === "absent"
			? {pass: false, reason: "vocabulary-absent", scope, missing: scope.vocabulary.missing}
			: {pass: true, scope, scanned: 0, pitched: 0};
	}

	const unpitched: Array<Unpitched> = [];
	let pitched = 0;
	for (const candidate of inScope) {
		const resolved = disposition(candidate);
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
const REMEDY =
	"Each issue above is pickable lane-entering work with no founder-approved pitch. Direction binds\n" +
	"at intake (founder ruling #3909); the §PITCH format is:\n" +
	`  1. triage DRAFTS a ## Pitch section with all five fields (${PITCH_FIELDS.join(" / ")}),\n` +
	"     where Arc restates the home the ADR 0202 rubric step already assigned;\n" +
	"  2. the FOUNDER approves it with a `pitch-approved: appetite <N> cycles · <ISO-8601-UTC>` comment\n" +
	"     naming the same <N> the body declares. Approval is a founder seat — an agent never posts it.";

/** Render the report for a verdict (ADR 0092 §1 — "emit what you scanned"). */
export const renderReport = (verdict: PitchGuardVerdict): string => {
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
			"fail-closed (ADR 0092). An empty set is indistinguishable from a broken read " +
			"(renamed label, missing token, wrong repo), and a vacuous pass would hide every unpitched bet."
		);
	}
	if (verdict.reason === "vocabulary-absent") {
		return (
			`pitch-guard: ${scopeLabel(verdict.scope)} is not lane-entering work, but the label(s) that ` +
			`define scope do not exist in this repo at all: ${verdict.missing.join(", ")} — unmet ` +
			"prerequisite (#4272), not an out-of-scope issue. Run `pipeline-cli vocabulary-preflight " +
			"check` and create the missing labels; adopting the pipeline means adopting its taxonomy."
		);
	}
	const lines = verdict.unpitched.map((i) => `  #${i.number} ${i.title}\n      ${i.detail}`);
	return (
		`pitch-guard: ${verdict.unpitched.length} of ${verdict.scanned} lane-entering issue(s) in ` +
		`${scopeLabel(verdict.scope)} are pickable without a founder-approved pitch ` +
		`(${verdict.pitched} pitched):\n${lines.join("\n")}\n\n${REMEDY}`
	);
};
