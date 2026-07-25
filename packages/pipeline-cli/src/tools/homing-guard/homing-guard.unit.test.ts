/**
 * Pure-core tests for `homing-guard` (#3939): the home-or-exempt disposition, the verdict
 * over a scanned set, the two zero-scope forks (backlog fails closed per ADR 0092, a single
 * non-triaged issue passes as out-of-scope), and the report. No IO — the `gh api` seam is
 * crossed in `gate.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	disposition,
	EXEMPT_LABELS,
	judge,
	renderReport,
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

	it("milestone WINS over a standing-lane label (ADR 0208's inverse ban is out of scope)", () => {
		expect(disposition(issue(1, 17, ["wayfinder:backlog"]))).toBe("homed");
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

describe("judge — un-homed", () => {
	it("FAILS and names every un-homed issue, not just the first", () => {
		const v = judge([issue(1, 17), issue(2, null), issue(3, null, ["p0"])]);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "unhomed") {
			expect(v.unhomed.map((u) => u.number)).toEqual([2, 3]);
			expect(v.scanned).toBe(3);
			expect(v.homed).toBe(1);
			expect(v.exempt).toBe(0);
		}
	});

	it("FAILS a single-issue scan of an un-homed issue", () => {
		const v = judge([issue(9, null)], {_tag: "issue", number: 9});
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "unhomed") {
			expect(v.unhomed).toEqual([{number: 9, title: "issue 9"}]);
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
		const v = judge([], {_tag: "issue", number: 9});
		expect(v.pass).toBe(true);
		if (v.pass) expect(v.scanned).toBe(0);
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
		const report = renderReport(judge([], {_tag: "issue", number: 9}));
		expect(report).toContain("issue #9 is not status:triaged");
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
});
