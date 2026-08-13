/**
 * The graded axis's own tier, driven entirely through a **stubbed grader** — no unit test here
 * spawns a model or spends a cent.
 *
 * The assertions that carry the design are the ones about what the median throws away and what a
 * dead invocation counts as: an even split resolves down, an all-fail set is a fail rather than an
 * absence, a run that returned no verdict stays in the denominator and never lands on the passing
 * side, and a case where every run died is `unmeasured` rather than a `0.0` nobody measured.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {emit as emitRecord, read} from "../wire/eval-record.ts";
import {summarizeEvalRows} from "./deterministic-tier.ts";
import {
	buildEvalRecord,
	composeGraderPrompt,
	GRADED_RUNS,
	GRADER_INSTRUCTIONS,
	type GradableCase,
	gradeCase,
	gradedCellAggregate,
	medianVerdict,
	perRunToken,
	type RunVerdict,
	readGraderVerdict,
	runGradedAxis,
	toEvalRow,
} from "./graded-axis.ts";

const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";

const pass: RunVerdict = {_tag: "Verdict", passed: true};
const fail: RunVerdict = {_tag: "Verdict", passed: false};
const dead = (reason: "no-output" | "timed-out"): RunVerdict => ({_tag: "NoVerdict", reason});

const caseOf = (id: number, over: Partial<GradableCase> = {}): GradableCase => ({
	id,
	prompt: "File a report for the guard that reds on zero scope.",
	expectedOutput: "One issue, tagged needs-triage.",
	expectations: ["it files exactly one issue", "the issue carries no priority label"],
	files: [`evals/cases/eval-${id}.md`],
	...over,
});

/** A grader stub: hands back a scripted verdict per (case, run) and counts what it was asked. */
const scriptedGrader = (script: ReadonlyArray<RunVerdict>) => {
	const calls: Array<{caseId: number; run: number}> = [];
	return {
		calls,
		runOnce: ({evalCase, run}: {evalCase: GradableCase; run: number}) => {
			calls.push({caseId: evalCase.id, run});
			return Effect.succeed(script[(run - 1) % script.length] ?? fail);
		},
	};
};

describe("the median over a case's runs", () => {
	it("is the majority at the ruled five runs", () => {
		expect(medianVerdict([pass, pass, pass, fail, fail])).toBe("pass");
		expect(medianVerdict([pass, pass, fail, fail, fail])).toBe("fail");
	});

	it("resolves an even split down — a half-failing set has not shown the case passes", () => {
		expect(medianVerdict([pass, fail])).toBe("fail");
		expect(medianVerdict([pass, pass, fail, fail])).toBe("fail");
	});

	it("is a fail over an all-fail set, never an absence", () => {
		const result = gradeCase(7, [fail, fail, fail, fail, fail]);
		expect(result.verdict).toBe("fail");
		expect(result.passed).toBe(0);
		expect(result.dispersion).toBe(0);
	});

	it("is unmeasured only when every run returned no verdict", () => {
		expect(medianVerdict([dead("timed-out"), dead("no-output")])).toBe("unmeasured");
		expect(medianVerdict([dead("timed-out"), pass])).toBe("fail");
		expect(medianVerdict([])).toBe("unmeasured");
	});
});

describe("a run that returns no verdict is typed and counted", () => {
	it("reads each of the four reasons off what the grader did", () => {
		expect(readGraderVerdict({_tag: "TimedOut"})).toEqual({
			_tag: "NoVerdict",
			reason: "timed-out",
		});
		expect(readGraderVerdict({_tag: "InvocationFailed", detail: "spawn"})).toEqual({
			_tag: "NoVerdict",
			reason: "invocation-failed",
		});
		expect(readGraderVerdict({_tag: "Returned", text: "  \n "})).toEqual({
			_tag: "NoVerdict",
			reason: "no-output",
		});
		expect(readGraderVerdict({_tag: "Returned", text: "I think it's fine, honestly."})).toEqual({
			_tag: "NoVerdict",
			reason: "unparseable",
		});
	});

	it("takes the last verdict line, so reasoning that mentions PASS on the way does not win", () => {
		const text =
			"It could be a PASS if you squint.\nBut the second expectation fails.\nVERDICT: FAIL";
		expect(readGraderVerdict({_tag: "Returned", text})).toEqual({_tag: "Verdict", passed: false});
	});

	it("stays in the denominator, never counts as passed, and is counted on its own", () => {
		const result = gradeCase(3, [pass, fail, pass, dead("timed-out"), pass]);
		expect(result.runs).toBe(5);
		expect(result.passed).toBe(3);
		expect(result.noVerdict).toBe(1);
		expect(result.dispersion).toBe(2);
		expect(result.perRun).toEqual(["pass", "fail", "pass", "no-verdict:timed-out", "pass"]);
	});

	it("makes a 3-of-5 with two dead invocations legible as a different fact from a 3-of-5 with two fails", () => {
		const honest = gradeCase(1, [pass, pass, pass, fail, fail]);
		const dying = gradeCase(1, [pass, pass, pass, dead("no-output"), dead("timed-out")]);
		expect(honest.verdict).toBe(dying.verdict);
		expect(honest.noVerdict).toBe(0);
		expect(dying.noVerdict).toBe(2);
	});

	it("spells every reason on the per-run token", () => {
		expect(perRunToken({_tag: "NoVerdict", reason: "unparseable"})).toBe("no-verdict:unparseable");
	});
});

describe("the five-run protocol", () => {
	it("runs each case exactly five times and never retries a dead invocation inside the block", () => {
		const grader = scriptedGrader([pass, dead("timed-out"), pass, fail, pass]);
		const results = Effect.runSync(
			runGradedAxis({cases: [caseOf(11), caseOf(12)], runOnce: grader.runOnce}),
		);
		expect(grader.calls.length).toBe(2 * GRADED_RUNS);
		expect(grader.calls.filter((call) => call.caseId === 11).map((call) => call.run)).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(results.map((result) => result.verdict)).toEqual(["pass", "pass"]);
		expect(results[0]?.noVerdict).toBe(1);
	});
});

describe("the grader is the authoring session's, not a second rubric", () => {
	const prompt = composeGraderPrompt({
		evalCase: caseOf(1),
		candidateOutput: "Filed #9001 with status:needs-triage.",
	});

	it("carries every authored expectation verbatim", () => {
		for (const expectation of caseOf(1).expectations) {
			expect(prompt).toContain(expectation);
		}
		expect(prompt).toContain("One issue, tagged needs-triage.");
	});

	it("adds no criterion of its own — everything not from the case is the fixed instruction block", () => {
		const authored = [
			...caseOf(1).expectations,
			caseOf(1).prompt,
			caseOf(1).expectedOutput ?? "",
			"Filed #9001 with status:needs-triage.",
		];
		const leftover = prompt
			.split("\n")
			.map((line) => line.replace(/^[-#]+\s*/, "").trim())
			.filter((line) => line !== "")
			.filter((line) => !authored.includes(line))
			.filter((line) => !GRADER_INSTRUCTIONS.includes(line as (typeof GRADER_INSTRUCTIONS)[number]))
			// The section headings are structure, not standard: they name where each authored block
			// came from and state no expectation of their own.
			.filter((line) => !line.startsWith("Prompt the skill"))
			.filter((line) => !line.startsWith("What the skill produced"))
			.filter((line) => !line.startsWith("Expected output"))
			.filter((line) => !line.startsWith("Expectations"));
		expect(leftover).toEqual([]);
	});
});

describe("graded rows fold through the one aggregator both tiers share", () => {
	it("emits an EvalRow summarizeEvalRows counts under the graded tier", () => {
		const rows = [
			toEvalRow(gradeCase(11, [pass, pass, pass, fail, fail]), caseOf(11)),
			toEvalRow(gradeCase(12, [fail, fail, fail, fail, fail]), caseOf(12)),
		];
		const summary = summarizeEvalRows(rows);
		expect(summary.byTier.graded.cases).toBe(2);
		expect(summary.byTier.graded.passed).toBe(1);
		expect(summary.verdict).toBe("red");
		expect(rows[0]?.runs).toBe(5);
	});

	it("reports an all-dead case as uncheckable, so the suite reds rather than scoring a zero", () => {
		const row = toEvalRow(
			gradeCase(13, [dead("timed-out"), dead("timed-out"), dead("no-output")]),
			caseOf(13),
		);
		expect(row.outcome).toBe("uncheckable");
		expect(summarizeEvalRows([row]).verdict).toBe("red");
	});
});

describe("the cell aggregate is spelled as a scorecard cell", () => {
	it("computes the pass rate over graded cases and excludes the unmeasured ones", () => {
		const results = [
			gradeCase(11, [pass, pass, pass, fail, fail]),
			gradeCase(12, [fail, fail, fail, fail, fail]),
			gradeCase(13, [dead("timed-out"), dead("timed-out"), dead("timed-out")]),
		];
		expect(gradedCellAggregate(results)).toEqual({
			gradedRuns: 2,
			passedRuns: 1,
			passRate: 0.5,
		});
	});
});

describe("the record is head-bound and written on every outcome", () => {
	const pins = {model: "claude-opus-4-6", cli: "2.1.220", harness: "fabrika 0.1.0"};
	const cell = {stage: "review", surface: "skill", model: "claude-opus-4-6"};

	it("binds the payload and the marker to the head the run was measured at", () => {
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [gradeCase(11, [pass, pass, pass, fail, fail])],
		});
		expect(built._tag).toBe("Record");
		if (built._tag !== "Record") return;
		expect(built.record.sha).toBe(HEAD);
		expect(built.record.payload.sha).toBe(HEAD);
		expect(built.record.payload.pins).toEqual(pins);
		expect(built.record.payload.cases[0]?.perRun).toEqual(["pass", "pass", "pass", "fail", "fail"]);
	});

	it("records a below-bar number rather than withholding the record", () => {
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [
				gradeCase(11, [fail, fail, fail, fail, fail]),
				gradeCase(12, [fail, fail, fail, fail, fail]),
			],
		});
		expect(built._tag).toBe("Record");
		if (built._tag !== "Record") return;
		expect(built.record.outcome).toBe("RECORDED");
		expect(built.record.payload.passRate).toBe(0);
	});

	it("records UNRECORDABLE when nothing could be measured — never a 0.0 rate", () => {
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [gradeCase(11, [dead("timed-out"), dead("no-output"), dead("timed-out")])],
		});
		expect(built._tag).toBe("Record");
		if (built._tag !== "Record") return;
		expect(built.record.outcome).toBe("UNRECORDABLE");
		expect(built.record.payload.gradedRuns).toBe(0);
		expect(built.record.clause).toContain("no measurement");
	});

	// The founder ruling on #4678 (comment 5247447078): a run that never reached a case still records,
	// naming which failure it was, so #4681 can tell a broken eval set from a review that never ran.
	it("records UNRECORDABLE naming why, for a run that never reached a case", () => {
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [],
			noMeasurement: "evals.json carries no graded case",
		});
		expect(built._tag).toBe("Record");
		if (built._tag !== "Record") return;
		expect(built.record.outcome).toBe("UNRECORDABLE");
		expect(built.record.payload.gradedRuns).toBe(0);
		expect(built.record.payload.cases).toEqual([]);
		expect(built.record.clause).toContain("carries no graded case");
	});

	it("refuses to build a record bound to something that is not a head", () => {
		const built = buildEvalRecord({
			sha: "HEAD~1",
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [gradeCase(11, [pass, pass, pass, fail, fail])],
		});
		expect(built._tag).toBe("Unusable");
	});

	it("produces bytes the registered wire format reads back", () => {
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-10T04:08:00Z",
			cell,
			pins,
			results: [
				gradeCase(11, [pass, pass, pass, pass, fail]),
				gradeCase(12, [pass, fail, pass, dead("timed-out"), pass]),
			],
		});
		if (built._tag !== "Record") throw new Error("the record did not build");
		const roundTripped = read(emitRecord(built.record));
		expect(roundTripped._tag).toBe("Found");
		if (roundTripped._tag !== "Found") return;
		expect(roundTripped.value.payload.cases.map((block) => block.dispersion)).toEqual([1, 2]);
	});
});
