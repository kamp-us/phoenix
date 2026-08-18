/**
 * `homing-guard` pure core — decide whether every `status:triaged` issue left triage with
 * exactly one home. Home and exemption are MUTUALLY EXCLUSIVE (ADR 0202 forward-motion
 * doctrine, ADR 0208 standing-lane exemption): a triaged issue carries an arc/campaign
 * milestone, or one of exactly two standing-lane labels, or it was killed and is no longer
 * open — never both marks at once, which ADR 0208 bans outright. IO-free and total — the
 * `gh api` read lives in `github.ts`/`gate.ts`.
 *
 * The guard is the teeth behind the rubric: without it the rubric lands advisory-only and
 * floaters regrow at the seam, which is the "teeth in a sweep, not at the seam" anti-pattern
 * ADR 0202 bans (#3939).
 *
 * Both directions of the invariant red here (#4069). Enforcing only the neither-marked half
 * read as full coverage downstream while double-marked issues landed in the `homed` count —
 * the milestone-counts-lie failure ADR 0202/0208 exist to prevent.
 */
import type {VocabularyPresence} from "../vocabulary-preflight/presence.ts";

/**
 * The two standing-lane labels, exactly (ADR 0208). A standing lane is milestone-less BY
 * DESIGN — fog (`wayfinder:backlog`) homes when it gets charted (ADR 0203), pipeline
 * hardening never completes into a milestone. Extending this set needs a founder ruling,
 * so it is a frozen literal, never a config surface or a pattern match.
 */
export const EXEMPT_LABELS: ReadonlyArray<string> = [
	"wayfinder:backlog",
	"axis:pipeline-hardening",
];

/** The label that puts an issue in scope: the invariant binds at the moment triage stamps it. */
export const TRIAGED_LABEL = "status:triaged";

/** One open `status:triaged` issue reduced to the two facts the invariant reads. */
export interface TriagedIssue {
	readonly number: number;
	readonly title: string;
	/** The issue's milestone number, or `null` when it carries none. */
	readonly milestone: number | null;
	readonly labels: ReadonlyArray<string>;
}

/**
 * What the guard scanned. `backlog` is the whole open `status:triaged` set (the CI/sweep
 * surface); `issue` is one named issue (the per-issue seam check a triage sweep runs right
 * after it labels). The two differ only in how an empty scope resolves — see `judge`.
 *
 * Issue scope carries the label universe's `vocabulary` because an empty issue scope has TWO
 * readings and the tool cannot tell them apart from the issue alone: "this issue is not
 * triaged" (ordinary, a pass) and "this repo has no such label" (an unmet prerequisite). The
 * fact is resolved at the IO boundary and arrives here, so a required field makes the
 * un-disambiguated pass unrepresentable rather than merely unchecked (#4272).
 */
export type Scope =
	| {readonly _tag: "backlog"}
	| {
			readonly _tag: "issue";
			readonly number: number;
			readonly vocabulary: VocabularyPresence;
	  };

/** How one triaged issue resolves against home-xor-exempt. The two right-hand cases are defects. */
export type Disposition = "homed" | "exempt" | "unhomed" | "double-marked";

/**
 * One issue that violates the invariant, tagged by which half it broke. One list of tagged
 * offenders rather than two parallel arrays keeps "a failing verdict names at least one
 * offender" the single non-empty check `judge` already made, with no both-empty state to
 * represent — and the report renders each kind under its own remedy.
 */
export type Violation =
	| {readonly kind: "unhomed"; readonly number: number; readonly title: string}
	| {
			readonly kind: "double-marked";
			readonly number: number;
			readonly title: string;
			readonly milestone: number;
			/** The standing-lane labels it carries alongside the milestone — the mark to drop, or keep. */
			readonly lanes: ReadonlyArray<string>;
	  };

/**
 * The verdict. A discriminated union so an invalid state is unrepresentable: a pass carries
 * only counts, the zero-scope fail carries the scope it found empty, and the violation fail
 * carries its non-empty offender list.
 */
export type HomingGuardVerdict =
	| {
			readonly pass: true;
			readonly scope: Scope;
			readonly scanned: number;
			readonly homed: number;
			readonly exempt: number;
	  }
	/** No triaged issue in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {
			readonly pass: false;
			readonly reason: "zero-scope";
			readonly scope: Scope;
	  }
	/** The scoping label does not exist in the repo at all — an unmet prerequisite (#4272). */
	| {
			readonly pass: false;
			readonly reason: "vocabulary-absent";
			readonly scope: Scope;
			readonly missing: ReadonlyArray<string>;
	  }
	| {
			readonly pass: false;
			readonly reason: "violations";
			readonly scope: Scope;
			readonly scanned: number;
			readonly homed: number;
			readonly exempt: number;
			readonly violations: ReadonlyArray<Violation>;
	  };

/**
 * How one issue resolved: a clean outcome, or the `Violation` it is — one shape, so a defect
 * always arrives carrying the detail its remedy needs, and the rule is stated in one place.
 */
export type Resolution = {readonly kind: "homed"} | {readonly kind: "exempt"} | Violation;

/** The standing-lane labels this issue carries (ADR 0208's exact two, no prefix matching). */
export const standingLanes = (issue: TriagedIssue): ReadonlyArray<string> =>
	issue.labels.filter((l) => EXEMPT_LABELS.includes(l));

/**
 * Resolve one issue against home-xor-exempt. A milestone homes it and a standing-lane label
 * exempts it, but carrying both is `double-marked` — ADR 0208 bans that combination in its
 * Banned list, and it never counts as homed.
 */
export const resolve = (issue: TriagedIssue): Resolution => {
	const lanes = standingLanes(issue);
	const {number, title} = issue;
	if (issue.milestone !== null) {
		return lanes.length > 0
			? {kind: "double-marked", number, title, milestone: issue.milestone, lanes}
			: {kind: "homed"};
	}
	return lanes.length > 0 ? {kind: "exempt"} : {kind: "unhomed", number, title};
};

/** The bare outcome of `resolve` — the four-way answer, without the offender detail. */
export const disposition = (issue: TriagedIssue): Disposition => resolve(issue).kind;

/**
 * Judge the scanned set.
 *
 * Zero scope forks on what was scanned. Over the whole **backlog**, an empty triaged set is
 * indistinguishable from a broken query (a renamed label, a lost token, a bad repo) — the
 * exact silent-no-op ADR 0092 makes fail closed. Over a single **issue**, empty is the
 * ordinary answer "that issue is not `status:triaged`", so it passes; the caller filters the
 * fetched issue by label, so an out-of-scope issue arrives here as an empty set.
 *
 * The issue fork passes ONLY when the scoping label exists in the repo. Where it does not,
 * every issue takes that fork and the seam guard reports clean forever, having checked nothing
 * — the vacuous pass #4272 closes.
 */
export const judge = (
	issues: ReadonlyArray<TriagedIssue>,
	scope: Scope = {_tag: "backlog"},
): HomingGuardVerdict => {
	if (issues.length === 0) {
		if (scope._tag === "backlog") return {pass: false, reason: "zero-scope", scope};
		return scope.vocabulary._tag === "absent"
			? {pass: false, reason: "vocabulary-absent", scope, missing: scope.vocabulary.missing}
			: {pass: true, scope, scanned: 0, homed: 0, exempt: 0};
	}

	const violations: Array<Violation> = [];
	let homed = 0;
	let exempt = 0;
	for (const issue of issues) {
		const resolution = resolve(issue);
		switch (resolution.kind) {
			case "homed":
				homed++;
				break;
			case "exempt":
				exempt++;
				break;
			default:
				violations.push(resolution);
				break;
		}
	}

	if (violations.length > 0) {
		return {
			pass: false,
			reason: "violations",
			scope,
			scanned: issues.length,
			homed,
			exempt,
			violations,
		};
	}
	return {pass: true, scope, scanned: issues.length, homed, exempt};
};

const scopeLabel = (scope: Scope): string =>
	scope._tag === "backlog" ? "the open status:triaged backlog" : `issue #${scope.number}`;

/** The un-homed remediation, stated once — the three outcomes the triage rubric allows. */
const UNHOMED_REMEDY =
	"Each issue above left triage un-homed. Give it one of the three home-or-exempt-or-kill outcomes\n" +
	"(claude-plugins/fabrika/skills/triage/SKILL.md, ADR 0202/0208):\n" +
	"  1. home it in an EXISTING open arc/campaign milestone from ROADMAP.md (triage never creates one);\n" +
	`  2. label it a standing lane — ${EXEMPT_LABELS.join(" or ")} — when it is milestone-less by design;\n` +
	"  3. kill it (close not-planned) when it does not move anything forward — agent-filed issues only,\n" +
	"     a human-filed issue is never auto-closed.";

/** The double-marked remediation: home and exemption are exclusive, so exactly one mark goes. */
const DOUBLE_MARKED_REMEDY =
	"Each issue above claims BOTH a home and a standing-lane exemption, which ADR 0208 bans outright\n" +
	'(Banned: "Milestones on wayfinder:backlog fog … or on axis:pipeline-hardening items"). A standing\n' +
	"lane is milestone-less BY DESIGN, so the two marks cannot both be true. Drop exactly one:\n" +
	"  1. drop the MILESTONE when the issue really is a standing lane — fog homes when it gets charted\n" +
	"     (ADR 0203), and pipeline hardening never completes into an arc;\n" +
	"  2. drop the STANDING-LANE LABEL when the issue is genuinely homed in that arc/campaign.\n" +
	"Leaving both makes the milestone burndown count an issue that also claims exemption from it.";

const violationLines = (violations: ReadonlyArray<Violation>, kind: Violation["kind"]): string =>
	violations
		.filter((v) => v.kind === kind)
		.map((v) =>
			v.kind === "double-marked"
				? `  #${v.number} ${v.title} — milestone ${v.milestone} + ${v.lanes.join(", ")}`
				: `  #${v.number} ${v.title}`,
		)
		.join("\n");

/** Render the report for a verdict (ADR 0092 §1 — "emit what you scanned"). */
export const renderReport = (verdict: HomingGuardVerdict): string => {
	if (verdict.pass) {
		if (verdict.scanned === 0) {
			return `homing-guard: ${scopeLabel(verdict.scope)} is not status:triaged — out of scope, nothing to check.`;
		}
		return (
			`homing-guard: ${scopeLabel(verdict.scope)} is fully homed — scanned ${verdict.scanned} triaged issue(s): ` +
			`${verdict.homed} milestone-homed, ${verdict.exempt} standing-lane exempt, 0 un-homed, 0 double-marked.`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`homing-guard: scanned ${scopeLabel(verdict.scope)} and found ZERO status:triaged issues — ` +
			"fail-closed (ADR 0092). An empty triaged set is indistinguishable from a broken read " +
			"(renamed label, missing token, wrong repo), and a vacuous pass would hide every floater."
		);
	}
	if (verdict.reason === "vocabulary-absent") {
		return (
			`homing-guard: ${scopeLabel(verdict.scope)} is not in scope, but the label(s) that define ` +
			`scope do not exist in this repo at all: ${verdict.missing.join(", ")} — unmet prerequisite ` +
			"(#4272), not an out-of-scope issue. Every issue would take this fork, so the seam guard " +
			"would report clean forever having checked nothing. Run `pipeline-cli vocabulary-preflight " +
			"check` and create the missing labels; adopting the pipeline means adopting its taxonomy."
		);
	}
	const unhomed = violationLines(verdict.violations, "unhomed");
	const doubleMarked = violationLines(verdict.violations, "double-marked");
	// Each defect class prints only when present, immediately above its own remedy, so a red is
	// self-explanatory without reading this source (#4069).
	const sections = [
		unhomed === ""
			? ""
			: `Left triage with NEITHER a milestone nor a standing-lane label:\n${unhomed}\n\n${UNHOMED_REMEDY}`,
		doubleMarked === ""
			? ""
			: `Carry BOTH a milestone and a standing-lane label:\n${doubleMarked}\n\n${DOUBLE_MARKED_REMEDY}`,
	].filter((s) => s !== "");
	return (
		`homing-guard: ${verdict.violations.length} of ${verdict.scanned} triaged issue(s) in ${scopeLabel(verdict.scope)} ` +
		`break home-xor-exempt (${verdict.homed} homed, ${verdict.exempt} exempt):\n\n${sections.join("\n\n")}`
	);
};
