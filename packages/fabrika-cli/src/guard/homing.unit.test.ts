/**
 * The `homing-guard` decision: the four-way home-xor-exempt disposition, the verdict over a scanned
 * set, the report's two defect classes, and the scan a clean verdict counts. No IO. The zero-scope
 * forks, the exit seats and the report lines a reader acts on are proven through the board read in
 * `./homing-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	disposition,
	judge,
	renderReport,
	resolve,
	type Scope,
	type TriagedIssue,
	toGuardVerdict,
} from "./homing.ts";
import {PRESENT} from "./label-universe.ts";

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

// Issue scope in a repo that HAS the label — the ordinary case.
const issueScope = (number: number): Scope => ({_tag: "issue", number, universe: PRESENT});

/** A repo's declared lanes, as a fixture: the decision carries no lane of its own. */
const LANES: ReadonlyArray<string> = ["wayfinder:backlog", "axis:pipeline-hardening"];

describe("the exempt set is the declared lanes", () => {
	it("exempts on a declared lane only — the same label declared nowhere is un-homed", () => {
		const lane = issue(1, null, ["wayfinder:backlog"]);
		expect(disposition(lane, ["wayfinder:backlog"])).toBe("exempt");
		expect(disposition(lane, ["axis:pipeline-hardening"])).toBe("unhomed");
		expect(disposition(lane, [])).toBe("unhomed");
	});

	it("never double-marks in a repo that declares no lane — a milestone is plain homed", () => {
		expect(disposition(issue(1, 17, ["wayfinder:backlog"]), [])).toBe("homed");
	});
});

describe("disposition", () => {
	it("a milestone homes the issue", () => {
		expect(disposition(issue(1, 17), LANES)).toBe("homed");
	});

	it.each([...LANES])("%s exempts a milestone-less issue", (label) => {
		expect(disposition(issue(1, null, [label]), LANES)).toBe("exempt");
	});

	it("no milestone and no standing-lane label is un-homed", () => {
		expect(disposition(issue(1, null, ["type:chore", "p2"]), LANES)).toBe("unhomed");
	});

	it("a look-alike label does NOT exempt (the set is exact, not a prefix match)", () => {
		expect(
			disposition(issue(1, null, ["axis:pipeline-hardening-ish", "wayfinder:map"]), LANES),
		).toBe("unhomed");
	});

	it.each([
		...LANES,
	])("a milestone AND %s is double-marked — banned outright, and it is never homed", (label) => {
		expect(disposition(issue(1, 17, [label]), LANES)).toBe("double-marked");
	});

	it("a double-marked resolution carries the milestone and the lanes its remedy names", () => {
		expect(resolve(issue(42, 17, ["wayfinder:backlog", "p2"]), LANES)).toEqual({
			kind: "double-marked",
			number: 42,
			title: "issue 42",
			milestone: 17,
			lanes: ["wayfinder:backlog"],
		});
	});

	it("a milestone plus a look-alike label is plain homed (the exempt set is exact)", () => {
		expect(disposition(issue(1, 17, ["axis:pipeline-hardening-ish"]), LANES)).toBe("homed");
	});
});

describe("judge — pass", () => {
	it("PASSES when every triaged issue is homed or exempt, counting each kind", () => {
		const v = judge(
			[
				issue(1, 17),
				issue(2, 24),
				issue(3, null, ["wayfinder:backlog"]),
				issue(4, null, ["axis:pipeline-hardening"]),
			],
			LANES,
		);
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
		const v = judge([issue(1, 17), issue(2, null), issue(3, null, ["p0"])], LANES);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations.map((u) => u.number)).toEqual([2, 3]);
			expect(v.scanned).toBe(3);
			expect(v.homed).toBe(1);
			expect(v.exempt).toBe(0);
		}
	});

	it("FAILS a single-issue scan of an un-homed issue", () => {
		const v = judge([issue(9, null)], LANES, issueScope(9));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations).toEqual([{kind: "unhomed", number: 9, title: "issue 9"}]);
		}
	});

	it("FAILS on a double-marked issue and keeps it OUT of the homed count", () => {
		const v = judge([issue(1, 17), issue(2, 24, ["axis:pipeline-hardening"])], LANES);
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
		const v = judge([issue(9, 17, ["wayfinder:backlog"])], LANES, issueScope(9));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "violations") {
			expect(v.violations.map((x) => x.kind)).toEqual(["double-marked"]);
		}
	});

	it("carries BOTH defect classes in one verdict — neither hides the other", () => {
		const v = judge([issue(1, null), issue(2, 24, ["wayfinder:backlog"]), issue(3, 17)], LANES);
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

describe("judge — zero scope", () => {
	it("defaults to backlog scope, so a bare empty scan still fails closed", () => {
		const v = judge([], LANES);
		expect(v.pass).toBe(false);
	});
});

describe("renderReport", () => {
	it("separates the two defect classes, each under its own remedy", () => {
		const report = renderReport(
			judge([issue(1, null), issue(2, 24, ["wayfinder:backlog"])], LANES),
		);
		expect(report).toContain("2 of 2 triaged issue(s)");
		expect(report).toContain("Left triage with NEITHER a milestone nor a standing-lane label");
		expect(report).toContain("Carry BOTH a milestone and a standing-lane label");
		expect(report.indexOf("#1 issue 1")).toBeLessThan(report.indexOf("#2 issue 2"));
	});

	it("prints ONLY the class that fired — no empty section for the other", () => {
		const report = renderReport(judge([issue(1, null)], LANES));
		expect(report).toContain("Left triage with NEITHER");
		expect(report).not.toContain("Carry BOTH");
	});

	it("offers the declared lanes in the un-homed remedy, and says so when the repo declares none", () => {
		expect(renderReport(judge([issue(1, null)], LANES))).toContain(
			"label it a standing lane — wayfinder:backlog or axis:pipeline-hardening —",
		);
		const none = renderReport(judge([issue(1, null)], []));
		expect(none).toContain("this repo declares none");
		expect(none).not.toContain("wayfinder:backlog");
	});
});

describe("toGuardVerdict", () => {
	it("counts an out-of-scope single issue as a scan of ONE, never as zero scope", () => {
		const verdict = toGuardVerdict(judge([], LANES, issueScope(9)));
		expect(verdict._tag).toBe("Clean");
		if (verdict._tag === "Clean") expect(verdict.scanned).toBe(1);
	});

	it("reports the backlog's own scanned count on a clean sweep", () => {
		const verdict = toGuardVerdict(
			judge([issue(1, 17), issue(2, null, ["wayfinder:backlog"])], LANES),
		);
		expect(verdict._tag).toBe("Clean");
		if (verdict._tag === "Clean") expect(verdict.scanned).toBe(2);
	});
});
