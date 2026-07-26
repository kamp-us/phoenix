/**
 * Pure-core tests for `homing-guard` (#3939, extended to both directions in #4069): the
 * four-way home-xor-exempt disposition, the verdict over a scanned set, the two zero-scope
 * forks (backlog fails closed per ADR 0092, a single non-triaged issue passes as
 * out-of-scope), and the report. No IO — the `gh api` seam is crossed in `gate.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {PRESENT, type VocabularyPresence} from "../vocabulary-preflight/presence.ts";
import {
	disposition,
	EXEMPT_LABELS,
	judge,
	renderReport,
	resolve,
	type Scope,
	type TriagedIssue,
} from "./homing-guard.ts";

const issue = (
	number: number,
	milestone: number | null,
	labels: ReadonlyArray<string> = [],
): TriagedIssue => ({
	number,
	title: `issue ${number}`,
	milestone,
	labels: ["status:triaged", ...labels],
});

const BACKLOG: Scope = {_tag: "backlog"};

// Issue scope defaults to a repo that HAS the label — the ordinary case. The absent reading is
// spelled out where it is the subject (#4272).
const issueScope = (number: number, vocabulary: VocabularyPresence = PRESENT): Scope => ({
	_tag: "issue",
	number,
	vocabulary,
});

describe("EXEMPT_LABELS", () => {
	it("is EXACTLY the two ADR-0208 standing lanes — a third needs a founder ruling", () => {
		expect([...EXEMPT_LABELS]).toEqual(["wayfinder:backlog", "axis:pipeline-hardening"]);
	});
});

describe("disposition", () => {
	it("a milestone homes the issue", () => {
		expect(disposition(issue(1, 17))).toBe("homed");
	});

	it.each([...EXEMPT_LABELS])("%s exempts a milestone-less issue", (label) => {
		expect(disposition(issue(1, null, [label]))).toBe("exempt");
	});

	it("no milestone and no standing-lane label is un-homed", () => {
		expect(disposition(issue(1, null, ["type:chore", "p2"]))).toBe("unhomed");
	});

	it("a look-alike label does NOT exempt (the set is exact, not a prefix match)", () => {
		expect(disposition(issue(1, null, ["axis:pipeline-hardening-ish", "wayfinder:map"]))).toBe(
			"unhomed",
		);
	});

	it.each([
		...EXEMPT_LABELS,
	])("a milestone AND %s is double-marked — ADR 0208 bans it, and it is never homed", (label) => {
		expect(disposition(issue(1, 17, [label]))).toBe("double-marked");
	});

	it("a double-marked resolution carries the milestone and the lanes its remedy names", () => {
		expect(resolve(issue(42, 17, ["wayfinder:backlog", "p2"]))).toEqual({
			kind: "double-marked",
			number: 42,
			title: "issue 42",
			milestone: 17,
			lanes: ["wayfinder:backlog"],
		});
	});

	it("a milestone plus a look-alike label is plain homed (the exempt set is exact)", () => {
		expect(disposition(issue(1, 17, ["axis:pipeline-hardening-ish"]))).toBe("homed");
	});
});

describe("judge — pass", () => {
	it("PASSES when every triaged issue is homed or exempt, counting each kind", () => {
		const v = judge([
			issue(1, 17),
			issue(2, 24),
			issue(3, null, ["wayfinder:backlog"]),
			issue(4, null, ["axis:pipeline-hardening"]),
		]);
		expect(v.pass).toBe(true);
		if (v.pass) {
			expect(v.scanned).toBe(4);
			expect(v.homed).toBe(2);
			expect(v.exempt).toBe(2);
		}
	});
});

describe("judge — violations", () => {
	it("FAILS and names every un-homed issue, not just the first", () => {
		const v = judge([issue(1, 17), issue(2, null), issue(3, null, ["p0"])]);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations.map((u) => u.number)).toEqual([2, 3]);
			expect(v.scanned).toBe(3);
			expect(v.homed).toBe(1);
			expect(v.exempt).toBe(0);
		}
	});

	it("FAILS a single-issue scan of an un-homed issue", () => {
		const v = judge([issue(9, null)], issueScope(9));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations).toEqual([{kind: "unhomed", number: 9, title: "issue 9"}]);
		}
	});

	it("FAILS on a double-marked issue and keeps it OUT of the homed count", () => {
		const v = judge([issue(1, 17), issue(2, 24, ["axis:pipeline-hardening"])]);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.homed).toBe(1);
			expect(v.exempt).toBe(0);
			expect(v.scanned).toBe(2);
			expect(v.violations).toEqual([
				{
					kind: "double-marked",
					number: 2,
					title: "issue 2",
					milestone: 24,
					lanes: ["axis:pipeline-hardening"],
				},
			]);
		}
	});

	it("FAILS a single-issue scan of a double-marked issue — the --issue seam reds too", () => {
		const v = judge([issue(9, 17, ["wayfinder:backlog"])], issueScope(9));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations.map((x) => x.kind)).toEqual(["double-marked"]);
		}
	});

	it("carries BOTH defect classes in one verdict — neither hides the other", () => {
		const v = judge([issue(1, null), issue(2, 24, ["wayfinder:backlog"]), issue(3, 17)]);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations.map((x) => [x.kind, x.number])).toEqual([
				["unhomed", 1],
				["double-marked", 2],
			]);
			expect(v.homed).toBe(1);
		}
	});
});

describe("judge — zero scope (ADR 0092)", () => {
	it("FAILS CLOSED on an empty BACKLOG scan — a vacuous pass would hide every floater", () => {
		const v = judge([], BACKLOG);
		expect(v.pass).toBe(false);
		if (!v.pass) expect(v.reason).toBe("zero-scope");
	});

	it("defaults to backlog scope, so a bare empty scan still fails closed", () => {
		const v = judge([]);
		expect(v.pass).toBe(false);
	});

	it("PASSES an empty SINGLE-ISSUE scan — that issue is simply not status:triaged", () => {
		const v = judge([], issueScope(9));
		expect(v.pass).toBe(true);
		if (v.pass) expect(v.scanned).toBe(0);
	});

	// The two readings of the SAME empty per-issue result, which the tool cannot tell apart from
	// the issue alone — the vacuous pass #4272 closes. The pass above is the first reading.
	it("FAILS the same empty scan when the label is absent from the REPO — not out of scope", () => {
		const v = judge([], issueScope(9, {_tag: "absent", missing: ["status:triaged"]}));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "vocabulary-absent") {
			expect(v.missing).toEqual(["status:triaged"]);
		}
	});
});

describe("renderReport", () => {
	it("emits what it scanned on a pass (ADR 0092 §1)", () => {
		const report = renderReport(judge([issue(1, 17), issue(2, null, ["wayfinder:backlog"])]));
		expect(report).toContain("scanned 2 triaged issue(s)");
		expect(report).toContain("1 milestone-homed");
		expect(report).toContain("1 standing-lane exempt");
	});

	it("names the out-of-scope issue on an empty single-issue scan", () => {
		const report = renderReport(judge([], issueScope(9)));
		expect(report).toContain("issue #9 is not status:triaged");
	});

	it("distinguishes an absent label universe from an out-of-scope issue, naming what is missing", () => {
		const report = renderReport(
			judge([], issueScope(9, {_tag: "absent", missing: ["status:triaged"]})),
		);
		expect(report).toContain("do not exist in this repo at all: status:triaged");
		expect(report).toContain("vocabulary-preflight");
		expect(report).not.toContain("out of scope, nothing to check");
	});

	it("explains the zero-scope refusal rather than just failing", () => {
		const report = renderReport(judge([], BACKLOG));
		expect(report).toContain("ZERO status:triaged issues");
		expect(report).toContain("ADR 0092");
	});

	it("lists each un-homed issue and the three remediation outcomes", () => {
		const report = renderReport(judge([issue(1, 17), issue(2, null)]));
		expect(report).toContain("#2 issue 2");
		expect(report).not.toContain("#1 issue 1");
		expect(report).toContain("home it in an EXISTING open arc/campaign milestone");
		expect(report).toContain("wayfinder:backlog or axis:pipeline-hardening");
		expect(report).toContain("kill it (close not-planned)");
	});

	it("names a double-marked issue with the two marks it carries, and its own remedy", () => {
		const report = renderReport(judge([issue(1, 17), issue(2, 24, ["wayfinder:backlog"])]));
		expect(report).toContain("Carry BOTH a milestone and a standing-lane label");
		expect(report).toContain("#2 issue 2 — milestone 24 + wayfinder:backlog");
		expect(report).toContain("ADR 0208");
		expect(report).toContain("drop the MILESTONE");
		expect(report).toContain("drop the STANDING-LANE LABEL");
	});

	it("separates the two defect classes, each under its own remedy", () => {
		const report = renderReport(judge([issue(1, null), issue(2, 24, ["wayfinder:backlog"])]));
		expect(report).toContain("2 of 2 triaged issue(s)");
		expect(report).toContain("Left triage with NEITHER a milestone nor a standing-lane label");
		expect(report).toContain("Carry BOTH a milestone and a standing-lane label");
		expect(report.indexOf("#1 issue 1")).toBeLessThan(report.indexOf("#2 issue 2"));
	});

	it("prints ONLY the class that fired — no empty section for the other", () => {
		const report = renderReport(judge([issue(1, null)]));
		expect(report).toContain("Left triage with NEITHER");
		expect(report).not.toContain("Carry BOTH");
	});
});
