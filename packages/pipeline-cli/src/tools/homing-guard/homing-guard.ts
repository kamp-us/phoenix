/**
 * `homing-guard` pure core — decide whether every `status:triaged` issue left triage with
 * a home. The invariant is the triage rubric's home-or-exempt-or-kill outcome (ADR 0202
 * forward-motion doctrine, ADR 0208 standing-lane exemption): a triaged issue carries an
 * arc/campaign milestone, or one of exactly two standing-lane labels, or it was killed and
 * is no longer open. IO-free and total — the `gh api` read lives in `github.ts`/`gate.ts`.
 *
 * The guard is the teeth behind the rubric: without it the rubric lands advisory-only and
 * floaters regrow at the seam, which is the "teeth in a sweep, not at the seam" anti-pattern
 * ADR 0202 bans (#3939).
 *
 * Deliberately NOT enforced here: ADR 0208's inverse ban (a milestone on an exempt lane).
 * That is a different invariant with a different remediation, and folding it in would red a
 * backlog for a defect this guard's report cannot explain (#3939 scope).
 */

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
 */
export type Scope = {readonly _tag: "backlog"} | {readonly _tag: "issue"; readonly number: number};

/** How one triaged issue resolves against home-or-exempt. */
export type Disposition = "homed" | "exempt" | "unhomed";

export interface Unhomed {
	readonly number: number;
	readonly title: string;
}

/**
 * The verdict. A discriminated union so an invalid state is unrepresentable: a pass carries
 * only counts, the zero-scope fail carries the scope it found empty, and the unhomed fail
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
	| {
			readonly pass: false;
			readonly reason: "unhomed";
			readonly scope: Scope;
			readonly scanned: number;
			readonly homed: number;
			readonly exempt: number;
			readonly unhomed: ReadonlyArray<Unhomed>;
	  };

/**
 * Resolve one issue. A milestone homes it; failing that, either standing-lane label exempts
 * it. An issue carrying both is `homed` — that combination is ADR 0208's inverse ban, which
 * this guard does not enforce (see the module docblock).
 */
export const disposition = (issue: TriagedIssue): Disposition => {
	if (issue.milestone !== null) return "homed";
	return issue.labels.some((l) => EXEMPT_LABELS.includes(l)) ? "exempt" : "unhomed";
};

/**
 * Judge the scanned set.
 *
 * Zero scope forks on what was scanned. Over the whole **backlog**, an empty triaged set is
 * indistinguishable from a broken query (a renamed label, a lost token, a bad repo) — the
 * exact silent-no-op ADR 0092 makes fail closed. Over a single **issue**, empty is the
 * ordinary answer "that issue is not `status:triaged`", so it passes; the caller filters the
 * fetched issue by label, so an out-of-scope issue arrives here as an empty set.
 */
export const judge = (
	issues: ReadonlyArray<TriagedIssue>,
	scope: Scope = {_tag: "backlog"},
): HomingGuardVerdict => {
	if (issues.length === 0) {
		return scope._tag === "backlog"
			? {pass: false, reason: "zero-scope", scope}
			: {pass: true, scope, scanned: 0, homed: 0, exempt: 0};
	}

	const unhomed: Array<Unhomed> = [];
	let homed = 0;
	let exempt = 0;
	for (const issue of issues) {
		switch (disposition(issue)) {
			case "homed":
				homed++;
				break;
			case "exempt":
				exempt++;
				break;
			case "unhomed":
				unhomed.push({number: issue.number, title: issue.title});
				break;
		}
	}

	if (unhomed.length > 0) {
		return {
			pass: false,
			reason: "unhomed",
			scope,
			scanned: issues.length,
			homed,
			exempt,
			unhomed,
		};
	}
	return {pass: true, scope, scanned: issues.length, homed, exempt};
};

const scopeLabel = (scope: Scope): string =>
	scope._tag === "backlog" ? "the open status:triaged backlog" : `issue #${scope.number}`;

/** The remediation, stated once — the three outcomes the triage rubric allows. */
const REMEDY =
	"Each issue above left triage un-homed. Give it one of the three home-or-exempt-or-kill outcomes\n" +
	"(claude-plugins/kampus-pipeline/skills/triage/SKILL.md, ADR 0202/0208):\n" +
	"  1. home it in an EXISTING open arc/campaign milestone from ROADMAP.md (triage never creates one);\n" +
	`  2. label it a standing lane — ${EXEMPT_LABELS.join(" or ")} — when it is milestone-less by design;\n` +
	"  3. kill it (close not-planned) when it does not move anything forward — agent-filed issues only,\n" +
	"     a human-filed issue is never auto-closed.";

/** Render the report for a verdict (ADR 0092 §1 — "emit what you scanned"). */
export const renderReport = (verdict: HomingGuardVerdict): string => {
	if (verdict.pass) {
		if (verdict.scanned === 0) {
			return `homing-guard: ${scopeLabel(verdict.scope)} is not status:triaged — out of scope, nothing to check.`;
		}
		return (
			`homing-guard: ${scopeLabel(verdict.scope)} is fully homed — scanned ${verdict.scanned} triaged issue(s): ` +
			`${verdict.homed} milestone-homed, ${verdict.exempt} standing-lane exempt, 0 un-homed.`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`homing-guard: scanned ${scopeLabel(verdict.scope)} and found ZERO status:triaged issues — ` +
			"fail-closed (ADR 0092). An empty triaged set is indistinguishable from a broken read " +
			"(renamed label, missing token, wrong repo), and a vacuous pass would hide every floater."
		);
	}
	const lines = verdict.unhomed.map((i) => `  #${i.number} ${i.title}`);
	return (
		`homing-guard: ${verdict.unhomed.length} of ${verdict.scanned} triaged issue(s) in ${scopeLabel(verdict.scope)} ` +
		`left triage with neither a milestone nor a standing-lane label ` +
		`(${verdict.homed} homed, ${verdict.exempt} exempt):\n${lines.join("\n")}\n\n${REMEDY}`
	);
};
