/**
 * Every red condition of the merge gate, and the two that are easiest to get wrong in the safe
 * direction: zero scope, and the path filter.
 *
 * The filter test is the #4604 reproduction. That incident was a `packages/`-anchored path filter
 * that excluded the skills directory, so a skill change matched nothing and the gate reported green
 * over it — a mistake that presents as a pass. Here the same decision is run twice over the same
 * changed-path set, once under the shipped filter and once under a deliberately mis-scoped one, and
 * the assertion is that the mis-scoped run erases the measurement-debt line the correctly-scoped run
 * prints. Since the graded demotion (#5498) neither run reds, so the visible difference moved from
 * red-versus-green to what the report says — but the property is the same one: not that the filter
 * matches, but that a wrong filter is *visible* in the artifact a reader acts on.
 *
 * **Which assertion catches a broken shipped filter — do not delete the siblings.** That
 * parameterised test passes its filter in explicitly, so it documents the failure mode and would
 * still pass if `SKILL_PATH_PREFIXES` were re-anchored wrong. The three assertions beside it are the
 * guard: `changedSkills(changed)` equals `["triage"]`, the same input names the debt, and
 * `SKILL_PATH_PREFIXES` contains the skills directory. Break the constant and those three go red.
 */
import {describe, expect, it} from "vitest";
import {type EvalRecord, read as readEvalRecord} from "../wire/eval-record.ts";
import {headSha} from "../wire/verdict-marker.ts";
import {
	ABOVE_BASELINE,
	BELOW_BAR,
	MISSING_RESULT,
	REGRESSION_FLOOR,
	STALE_HEAD,
	ZERO_SCOPE,
} from "./codes.ts";
import type {BaselineComparison} from "./cost-baseline.ts";
import type {EvalRow, TieredEvalCase} from "./deterministic-tier.ts";
import type {FloorCommands} from "./floor-commands.ts";
import {
	changedSkills,
	decideGate,
	floorScope,
	GRADED_BAR,
	gateToJson,
	judgeFloor,
	judgeGraded,
	judgeScope,
	judgeSpend,
	latestPerCell,
	REASON_CODES,
	renderGate,
	SKILL_PATH_PREFIXES,
	unmeasuredLegs,
} from "./gate.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OLDER = "7be402c1d3e5f60718293a4b5c6d7e8f90a1b2c3";

const head = (raw: string) => {
	const sha = headSha(raw);
	if (sha === null) throw new Error(`fixture ${raw} is not a head sha`);
	return sha;
};

/** Compose a record through the wire format and read it back, so no fixture can be an invalid one. */
const record = (args: {
	sha: string;
	recordedAt: string;
	stage?: string;
	surface?: string | null;
	model?: string;
	passed: number;
	graded: number;
}): EvalRecord => {
	const cases = Array.from({length: args.graded}, (_, index) => {
		const passes = index < args.passed;
		return {
			caseId: index + 1,
			verdict: passes ? "pass" : "fail",
			runs: 5,
			passed: passes ? 5 : 0,
			noVerdict: 0,
			dispersion: 0,
			perRun: Array.from({length: 5}, () => (passes ? "pass" : "fail")),
		};
	});
	const rate = args.graded === 0 ? 0 : Math.round((args.passed / args.graded) * 10_000) / 10_000;
	const outcome = args.graded === 0 ? "UNRECORDABLE" : "RECORDED";
	const text = [
		`eval: ${outcome} @ ${args.sha} — a graded run`,
		"",
		"```json",
		JSON.stringify(
			{
				sha: args.sha,
				recordedAt: args.recordedAt,
				cell: {
					stage: args.stage ?? "review",
					surface: args.surface ?? null,
					model: args.model ?? "claude-opus-4-8",
				},
				pins: {model: args.model ?? "claude-opus-4-8", cli: "2.1.227", harness: "0.1.0"},
				gradedRuns: args.graded,
				passedRuns: args.passed,
				unmeasuredCases: 0,
				passRate: rate,
				cases,
			},
			null,
			2,
		),
		"```",
		"",
	].join("\n");
	const parsed = readEvalRecord(text);
	if (parsed._tag !== "Found") throw new Error(`fixture is not a record: ${parsed.reason}`);
	return parsed.value;
};

const mechanicalCase = (id: number): TieredEvalCase => ({
	id,
	tier: "deterministic",
	assertions: [{kind: "mechanical", text: "The check exits 0.", cue: "exit-status"}],
});

const sidecar = (rows: FloorCommands["rows"]): FloorCommands => ({
	corpus: "fixture",
	rows,
});

const armed = (id: number) => ({status: "armed" as const, caseId: id, command: "true", args: []});

const pending = (id: number) => ({
	status: "pending" as const,
	caseId: id,
	pendingReason: "no CLI-layer command exists for it yet",
});

const row = (id: number, outcome: EvalRow["outcome"]): EvalRow => ({
	caseId: id,
	tier: "deterministic",
	outcome,
	runs: 1,
	assertions: [],
	detail: outcome === "pass" ? null : "the case did not pass",
});

const comparison = (verdict: BaselineComparison["verdict"]): BaselineComparison => ({
	verdict,
	reason: `the candidate is ${verdict}`,
	baselineBilled: 100,
	candidateBilled: verdict === "above" ? 200 : 50,
	deltaBilled: verdict === "incomparable" ? null : -50,
});

describe("the skill path filter (the #4604 reproduction)", () => {
	const changed = [
		"claude-plugins/fabrika/skills/triage/SKILL.md",
		"packages/fabrika-cli/src/eval/gate.ts",
	];

	it("sees the skills directory the shipped filter is anchored on", () => {
		expect(changedSkills(changed)).toEqual(["triage"]);
	});

	it("reports the debt by name on a skill change with no recorded result", () => {
		const verdict = judgeGraded({
			changedSkills: changedSkills(changed),
			records: [],
			head: head(HEAD),
		});
		expect(verdict.red).toBeNull();
		expect(verdict.line).toContain("triage");
		expect(verdict.line).toContain("a measurement is owed");
	});

	it("erases that debt line under a mis-scoped filter — the mistake is still visible in the report", () => {
		// #4604's own shape: a filter anchored inside `packages/` that never reaches a skills directory.
		// Since the demotion (#5498) neither run reds, so what a wrong filter destroys is the DEBT
		// LINE: the correctly-scoped run names the skill and what it owes, the mis-scoped one says the
		// change touches no skill at all. That difference is what the property now holds onto.
		const misScoped = changedSkills(changed, ["packages/pipeline-cli/src/"]);
		expect(misScoped).toEqual([]);
		const verdict = judgeGraded({changedSkills: misScoped, records: [], head: head(HEAD)});
		expect(verdict.line).toContain("n/a");
		expect(verdict.line).not.toContain("a measurement is owed");
	});

	it("anchors on the fabrika skills directory, not on a package path", () => {
		expect(SKILL_PATH_PREFIXES).toContain("claude-plugins/fabrika/skills/");
		expect(changedSkills(["claude-plugins/fabrika/skills/ship/contract.md"])).toEqual(["ship"]);
		expect(changedSkills(["claude-plugins/fabrika/docs/cost-baseline.md"])).toEqual([]);
	});
});

describe("zero scope", () => {
	it("reds when the change declares no path", () => {
		expect(judgeScope([]).red?.reason).toBe("zero-scope");
	});

	it("reds when the corpus carries no deterministic case", () => {
		const verdict = judgeFloor({
			scope: {armed: [], pending: [], unaccounted: []},
			rows: [],
			deterministicCases: 0,
		});
		expect(verdict.red?.reason).toBe("zero-scope");
	});

	it("reds when a corpus case is neither armed nor deferred in writing", () => {
		const scope = floorScope([mechanicalCase(1)], sidecar([]));
		expect(scope.unaccounted).toEqual([1]);
		const verdict = judgeFloor({scope, rows: [], deterministicCases: 1});
		expect(verdict.red?.reason).toBe("zero-scope");
	});

	it("reds when a candidate ledger has no committed baseline to price it against", () => {
		expect(judgeSpend({_tag: "NoBaseline", dir: "reports/eval"}).red?.reason).toBe("zero-scope");
	});
});

describe("the regression floor", () => {
	it("reds when an armed case does not pass — no tolerance", () => {
		const scope = floorScope([mechanicalCase(1), mechanicalCase(2)], sidecar([armed(1), armed(2)]));
		const verdict = judgeFloor({
			scope,
			rows: [row(1, "pass"), row(2, "fail")],
			deterministicCases: 2,
		});
		expect(verdict.red?.reason).toBe("regression-floor");
		expect(verdict.line).toContain("no tolerance and no quarantine");
	});

	it("reds an `uncheckable` armed case too — a case defect is never green", () => {
		const scope = floorScope([mechanicalCase(1)], sidecar([armed(1)]));
		const verdict = judgeFloor({scope, rows: [row(1, "uncheckable")], deterministicCases: 1});
		expect(verdict.red?.reason).toBe("regression-floor");
	});

	it("passes when every armed case passes, and still names what is pending", () => {
		const scope = floorScope(
			[mechanicalCase(1), mechanicalCase(2)],
			sidecar([armed(1), pending(2)]),
		);
		const verdict = judgeFloor({scope, rows: [row(1, "pass")], deterministicCases: 2});
		expect(verdict.red).toBeNull();
		expect(verdict.line).toContain("1/1");
		expect(verdict.line).toContain("pending arming (2)");
	});

	it("reports an all-pending floor as NOT MEASURED rather than reding, and says so on every run", () => {
		const scope = floorScope([mechanicalCase(1)], sidecar([pending(1)]));
		const verdict = judgeFloor({scope, rows: [], deterministicCases: 1});
		expect(verdict.red).toBeNull();
		expect(verdict.status).toBe("unmeasured");
		expect(verdict.line).toContain("NOT MEASURED");
		expect(verdict.line).toContain("no incident case is armed to run yet");
	});
});

describe("the graded leg reports the recorded head-bound result and never reds (#5498)", () => {
	const skills = ["triage"];
	const missing = () => judgeGraded({changedSkills: skills, records: [], head: head(HEAD)});
	const stale = () =>
		judgeGraded({
			changedSkills: skills,
			records: [record({sha: OLDER, recordedAt: "2026-08-11T00:00:00Z", passed: 10, graded: 10})],
			head: head(HEAD),
		});
	const belowBar = () =>
		judgeGraded({
			changedSkills: skills,
			records: [record({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z", passed: 8, graded: 10})],
			head: head(HEAD),
		});
	const unrecordable = () =>
		judgeGraded({
			changedSkills: skills,
			records: [record({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z", passed: 0, graded: 0})],
			head: head(HEAD),
		});

	// The demotion's whole content: the four states that used to seat exit codes 21/18/7/22 now seat
	// none. Asserted as one sweep so a state that quietly regains teeth cannot pass unnoticed.
	it("reds on none of the four states that used to fail a PR", () => {
		for (const verdict of [missing(), stale(), belowBar(), unrecordable()]) {
			expect(verdict.red).toBeNull();
			expect(verdict.line).toContain("REPORTED, NOT ENFORCED");
		}
	});

	it("never presents a demoted state as a leg that passed — it is unmeasured, not measured", () => {
		for (const verdict of [missing(), stale(), belowBar(), unrecordable()]) {
			expect(verdict.status).toBe("unmeasured");
		}
	});

	it("names the run site on every debt line — the lane that reads it cannot take the measurement", () => {
		for (const verdict of [missing(), stale()]) {
			expect(verdict.line).toContain("to clear this debt:");
			expect(verdict.line).toContain("plain, non-worktree session");
			expect(verdict.line).toContain("never inside a build lane");
			expect(verdict.line).toContain("hands the measurement off");
		}
		// #5406 is the whole reason the site has to be named: the lane's harness refuses the runner, so
		// "run the suite" without a site is an instruction the lane cannot follow.
		expect(stale().line).toContain("#5406");
	});

	it("reports which head the newest record is bound to when it is not this one", () => {
		expect(stale().line).toContain(OLDER);
	});

	it("still prints the score and the bar it fell under", () => {
		const verdict = belowBar();
		expect(verdict.line).toContain("0.8");
		expect(verdict.line).toContain(String(GRADED_BAR));
		if (verdict.status !== "unmeasured") throw new Error("a below-bar rate must stay unmeasured");
		expect(verdict.notMeasured).toContain("release criterion");
	});

	it("passes a rate exactly at the bar — the bar is `at or above`", () => {
		const verdict = judgeGraded({
			changedSkills: skills,
			records: [record({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z", passed: 9, graded: 10})],
			head: head(HEAD),
		});
		expect(verdict.red).toBeNull();
		expect(verdict.status).toBe("measured");
	});

	it("reports an UNRECORDABLE record as measuring nothing — never as a rate", () => {
		expect(unrecordable().line).toContain("UNRECORDABLE");
	});

	it("takes the latest record per cell, so a re-run at the same head supersedes", () => {
		const older = record({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z", passed: 5, graded: 10});
		const newer = record({sha: HEAD, recordedAt: "2026-08-11T09:00:00Z", passed: 10, graded: 10});
		expect(latestPerCell([older, newer])).toEqual([newer]);
		expect(
			judgeGraded({changedSkills: skills, records: [older, newer], head: head(HEAD)}).red,
		).toBeNull();
	});

	it("is n/a when no fabrika skill changed — unmeasured, not passed", () => {
		const verdict = judgeGraded({changedSkills: [], records: [], head: head(HEAD)});
		expect(verdict.red).toBeNull();
		expect(verdict.status).toBe("unmeasured");
		expect(verdict.line).toContain("n/a");
	});
});

describe("the spend leg", () => {
	it("reds above the committed v1 baseline", () => {
		expect(judgeSpend({_tag: "Compared", comparison: comparison("above")}).red?.reason).toBe(
			"over-baseline",
		);
	});

	it("reds `incomparable` too — it is never read as a cheaper run", () => {
		const verdict = judgeSpend({_tag: "Compared", comparison: comparison("incomparable")});
		expect(verdict.red?.reason).toBe("over-baseline");
		expect(verdict.line).toContain("incomparable");
	});

	it("passes at or below the baseline", () => {
		expect(judgeSpend({_tag: "Compared", comparison: comparison("at-or-below")}).red).toBeNull();
	});

	it("names an unmeasured change rather than folding it into a pass", () => {
		const verdict = judgeSpend({_tag: "NoLedger", path: ".fabrika/spend-ledger.jsonl"});
		expect(verdict.red).toBeNull();
		expect(verdict.status).toBe("unmeasured");
		expect(verdict.line).toContain("not-priced");
	});
});

/**
 * The reporting-side half of the #4604 shape: not a filter that saw nothing, but a summary that
 * reported health it never measured. These assertions are what stop the summary sentence drifting
 * back to one that a reader of a green check would take as an enforcement.
 */
describe("the summary never claims a bar it did not measure", () => {
	const unarmedFloor = judgeFloor({
		scope: floorScope([mechanicalCase(1)], sidecar([pending(1)])),
		rows: [],
		deterministicCases: 1,
	});

	it("says NOT FULLY MEASURED, and names each unmeasured leg, when a leg measured nothing", () => {
		const verdict = decideGate({
			legs: [
				judgeScope(["a.ts"]),
				unarmedFloor,
				judgeGraded({changedSkills: [], records: [], head: head(HEAD)}),
				judgeSpend({_tag: "NoLedger", path: ".fabrika/spend-ledger.jsonl"}),
			],
		});
		const report = renderGate(verdict);
		expect(verdict.verdict).toBe("green");
		expect(report).not.toContain("every ruled leg");
		expect(report).toContain("gate: NOT FULLY MEASURED");
		expect(report).toContain("3 of 4 leg(s) measured NOTHING");
		expect(report).toContain("0 of 1 incident case(s) armed");
		expect(report).toContain("n/a — this change touches no fabrika skill");
		expect(report).toContain("not-priced");
		expect(report).toContain("Measured and met: scope");
	});

	it("says the bar was measured and met only when every leg measured", () => {
		const scope = floorScope([mechanicalCase(1)], sidecar([armed(1)]));
		const verdict = decideGate({
			legs: [
				judgeScope(["a.ts"]),
				judgeFloor({scope, rows: [row(1, "pass")], deterministicCases: 1}),
				judgeGraded({
					changedSkills: ["triage"],
					records: [
						record({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z", passed: 10, graded: 10}),
					],
					head: head(HEAD),
				}),
				judgeSpend({_tag: "Compared", comparison: comparison("at-or-below")}),
			],
		});
		const report = renderGate(verdict);
		expect(unmeasuredLegs(verdict)).toEqual([]);
		expect(report).toContain("all 4 leg(s) of the ruled bar were measured and met");
		expect(report).not.toContain("NOT MEASURED");
	});

	it("carries the unmeasured legs into the JSON form too, beside the reds", () => {
		const verdict = decideGate({legs: [judgeScope(["a.ts"]), unarmedFloor]});
		const parsed = JSON.parse(gateToJson(verdict));
		expect(parsed.reds).toEqual([]);
		expect(parsed.unmeasured).toHaveLength(1);
		expect(parsed.legs.map((leg: {status: string}) => leg.status)).toEqual([
			"measured",
			"unmeasured",
		]);
	});
});

describe("the folded verdict", () => {
	it("is green only when no leg raised a red", () => {
		const verdict = decideGate({
			legs: [judgeScope(["a.ts"]), judgeSpend({_tag: "NoLedger", path: "x"})],
		});
		expect(verdict.verdict).toBe("green");
		expect(verdict.code).toBe(0);
	});

	it("carries every red and seats the exit code on the highest-precedence one", () => {
		const verdict = decideGate({
			legs: [
				judgeScope([]),
				judgeFloor({
					scope: floorScope([mechanicalCase(1)], sidecar([armed(1)])),
					rows: [row(1, "fail")],
					deterministicCases: 1,
				}),
				judgeSpend({_tag: "Compared", comparison: comparison("above")}),
			],
		});
		expect(verdict.reds.map((r) => r.reason)).toEqual([
			"zero-scope",
			"regression-floor",
			"over-baseline",
		]);
		expect(verdict.code).toBe(ZERO_SCOPE);
	});

	// The three graded seats keep their numbers and lose their PR-side producer: the demotion (#5498)
	// took the graded leg out of the failing set, and the release criterion still refuses on them.
	it("keeps the graded reasons on their own seats even with no leg producing them", () => {
		expect(REASON_CODES.missing).toBe(MISSING_RESULT);
		expect(REASON_CODES.stale).toBe(STALE_HEAD);
		expect(REASON_CODES["below-bar"]).toBe(BELOW_BAR);
	});

	it("seats each reason on the code its group already means it by", () => {
		const seat = (legs: Parameters<typeof decideGate>[0]["legs"]) => decideGate({legs}).code;
		expect(
			seat([
				judgeFloor({
					scope: floorScope([mechanicalCase(1)], sidecar([armed(1)])),
					rows: [row(1, "fail")],
					deterministicCases: 1,
				}),
			]),
		).toBe(REGRESSION_FLOOR);
		expect(seat([judgeSpend({_tag: "Compared", comparison: comparison("above")})])).toBe(
			ABOVE_BASELINE,
		);
	});

	it("reports the trend and never lets it change the verdict", () => {
		const declining = {
			series: {
				key: "k",
				cell: {stage: "review", surface: null, model: "m"},
				points: [],
			},
			result: {
				answer: "declining" as const,
				window: null,
				olderCount: 3,
				newerCount: 3,
				meanDrop: 0.2,
				separated: true,
				reason: "the halves do not overlap",
			},
		};
		const verdict = decideGate({legs: [judgeScope(["a.ts"])], trend: [declining]});
		expect(verdict.verdict).toBe("green");
		expect(renderGate(verdict)).toContain("trend: declining");
	});
});
