/**
 * The committed scorecard's own tier.
 *
 * The assertions that carry the design are the refusals: a scorecard that cannot say what it was
 * measured on, one whose cell cites no eval record, and one whose stored aggregate disagrees with its
 * own case list are each rejected rather than committed. The pin-completeness rejection is #4680's
 * fourth acceptance criterion, so it is exercised once per pin rather than once in total.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {Result} from "effect";
import {describe, expect, it} from "vitest";
import type {EvalRecord, EvalRecordPins} from "../wire/eval-record.ts";
import {read as readRecord} from "../wire/eval-record.ts";
import {
	buildCommittedScorecard,
	type CommittedCell,
	decodeCommittedScorecard,
	isSeriesFileName,
	SERIES_DIR,
	seriesFileName,
	toJson,
} from "./committed-scorecard.ts";
import type {GradedCaseResult} from "./graded-axis.ts";
import {buildEvalRecord} from "./graded-axis.ts";

const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";
const PINS: EvalRecordPins = {model: "opus-4.8", cli: "2.1.220", harness: "0.1.0"};

const caseResult = (
	caseId: number,
	verdict: GradedCaseResult["verdict"],
	passed: number,
): GradedCaseResult => ({
	caseId,
	verdict,
	runs: verdict === "unmeasured" ? 5 : 5,
	passed,
	noVerdict: verdict === "unmeasured" ? 5 : 0,
	dispersion: Math.min(passed, 5 - passed),
	perRun:
		verdict === "unmeasured"
			? Array.from({length: 5}, () => "no-verdict:no-output")
			: Array.from({length: 5}, (_, i) => (i < passed ? "pass" : "fail")),
});

const recordWith = (args: {
	readonly pins?: EvalRecordPins;
	readonly results?: ReadonlyArray<GradedCaseResult>;
	readonly stage?: string;
	readonly model?: string;
}): EvalRecord => {
	const built = buildEvalRecord({
		sha: HEAD,
		recordedAt: "2026-08-11T00:00:00Z",
		cell: {stage: args.stage ?? "review", surface: "skill", model: args.model ?? "opus-4.8"},
		pins: args.pins ?? PINS,
		results: args.results ?? [caseResult(1, "pass", 5), caseResult(2, "fail", 1)],
		noMeasurement: "the set carries no graded case",
	});
	if (built._tag !== "Record") throw new Error(`fixture is unusable: ${built.reason}`);
	return built.record;
};

describe("buildCommittedScorecard", () => {
	it("digests a record into a dated, pinned, sourced cell", () => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [recordWith({})],
		});
		expect(built._tag).toBe("Scorecard");
		if (built._tag !== "Scorecard") return;
		expect(built.scorecard.recordedAt).toBe("2026-08-11T01:02:03Z");
		const cell = built.scorecard.cells[0];
		expect(cell?.pins).toEqual(PINS);
		expect(cell?.source).toEqual({sha: HEAD, recordedAt: "2026-08-11T00:00:00Z"});
		// Cases, not invocations: two graded cases behind ten executions is a 1/2 rate (#5258).
		expect(cell?.gradedRuns).toBe(2);
		expect(cell?.passedRuns).toBe(1);
		expect(cell?.passRate).toBe(0.5);
	});

	it("rejects a scorecard over no record at all", () => {
		const built = buildCommittedScorecard({recordedAt: "2026-08-11T01:02:03Z", records: []});
		expect(built._tag === "Rejected" && built.rejection).toBe("zero-scope");
	});

	it.each([
		"model",
		"cli",
		"harness",
	] as const)("rejects rather than commits a scorecard whose %s pin is blank", (pin) => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [recordWith({pins: {...PINS, [pin]: "   "}})],
		});
		expect(built._tag === "Rejected" && built.rejection).toBe("missing-pin");
		expect(built._tag === "Rejected" && built.reason).toContain(pin);
	});

	it("rejects two records claiming one cell — a scorecard carries one point per cell", () => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [recordWith({}), recordWith({})],
		});
		expect(built._tag === "Rejected" && built.rejection).toBe("duplicate-cell");
	});

	it("keeps a broken run distinguishable from an absent one", () => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [recordWith({results: []})],
		});
		expect(built._tag).toBe("Scorecard");
		if (built._tag !== "Scorecard") return;
		expect(built.scorecard.cells[0]?.outcome).toBe("UNRECORDABLE");
		expect(built.scorecard.cells[0]?.gradedRuns).toBe(0);
	});

	it("excludes an unmeasured case from the rate rather than scoring it zero", () => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [
				recordWith({
					results: [
						caseResult(1, "pass", 5),
						caseResult(2, "pass", 4),
						caseResult(3, "pass", 5),
						caseResult(4, "unmeasured", 0),
					],
				}),
			],
		});
		if (built._tag !== "Scorecard") throw new Error("expected a scorecard");
		const cell = built.scorecard.cells[0];
		expect(cell?.passRate).toBe(1);
		// The rate alone would read as a clean sweep; the field is what keeps the dead case visible.
		expect(cell?.unmeasuredCases).toBe(1);
	});
});

const committedOf = (over: Partial<CommittedCell> = {}): string => {
	const built = buildCommittedScorecard({
		recordedAt: "2026-08-11T01:02:03Z",
		records: [recordWith({})],
	});
	if (built._tag !== "Scorecard") throw new Error("fixture is unusable");
	const cell = built.scorecard.cells[0];
	if (cell === undefined) throw new Error("fixture carries no cell");
	return toJson({...built.scorecard, cells: [{...cell, ...over}]});
};

describe("decodeCommittedScorecard", () => {
	it("round-trips what build produced", () => {
		const decoded = decodeCommittedScorecard(committedOf());
		expect(Result.isSuccess(decoded)).toBe(true);
	});

	it("refuses a body that is not JSON", () => {
		const decoded = decodeCommittedScorecard("not json");
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("malformed-json");
	});

	it("refuses a cell whose pin went blank after the fact", () => {
		const decoded = decodeCommittedScorecard(committedOf({pins: {...PINS, cli: ""}}));
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("missing-pin");
	});

	it("refuses an unsourced cell on the same footing as a missing pin", () => {
		const decoded = decodeCommittedScorecard(
			committedOf({source: {sha: "", recordedAt: "2026-08-11T00:00:00Z"}}),
		);
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("unsourced-cell");
	});

	it("refuses an aggregate its own case list contradicts", () => {
		const decoded = decodeCommittedScorecard(committedOf({passedRuns: 2, passRate: 1}));
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("inconsistent-aggregate");
	});

	it("refuses a RECORDED cell over zero graded cases", () => {
		const decoded = decodeCommittedScorecard(
			committedOf({outcome: "RECORDED", cases: [], gradedRuns: 0, passedRuns: 0, passRate: 0}),
		);
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("inconsistent-aggregate");
	});

	it("refuses a scorecard carrying no cell", () => {
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [recordWith({})],
		});
		if (built._tag !== "Scorecard") throw new Error("fixture is unusable");
		const decoded = decodeCommittedScorecard(toJson({...built.scorecard, cells: []}));
		expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("zero-scope");
	});
});

describe("seriesFileName", () => {
	it("names the file for the run's UTC date, so a listing sorts chronologically", () => {
		expect(seriesFileName("2026-08-11T01:02:03Z", [])).toBe("2026-08-11.json");
	});

	it("never rewrites a committed point — a second run that day takes the next suffix", () => {
		expect(seriesFileName("2026-08-11T09:00:00Z", ["2026-08-11.json"])).toBe("2026-08-11-2.json");
		expect(seriesFileName("2026-08-11T09:00:00Z", ["2026-08-11.json", "2026-08-11-2.json"])).toBe(
			"2026-08-11-3.json",
		);
	});
});

describe("isSeriesFileName is the inverse of seriesFileName", () => {
	// Re-derived rather than asserted against a hand-written list: the admission test and the name
	// generator are one fact, and a list would be a second copy of it that can drift.
	it("admits every name the writer can produce, over a whole day of same-date runs", () => {
		const taken: Array<string> = [];
		for (let run = 0; run < 12; run += 1) {
			const name = seriesFileName("2026-08-11T01:02:03Z", taken);
			expect(isSeriesFileName(name)).toBe(true);
			taken.push(name);
		}
	});

	it("does not admit the eval layer's other dated artifacts sharing the directory", () => {
		// The real neighbour: #4679's cost baseline lands in the same directory as the series.
		expect(isSeriesFileName("baseline-v1-2026-08-11.json")).toBe(false);
		expect(isSeriesFileName("README.md")).toBe(false);
		expect(isSeriesFileName("2026-08-11.json.bak")).toBe(false);
		expect(isSeriesFileName("notes-2026-08-11.json")).toBe(false);
	});
});

/**
 * Emit-then-format is a no-op: the emitter's bytes already ARE the formatter's bytes.
 *
 * Asserting "the output contains a tab" would pass on any output biome still wants to rewrite. This
 * asserts the property that actually ends the recurrence, and it is checkable because CI runs
 * `biome check .` over the whole repo: every committed series file below is, at HEAD, exactly what
 * biome produces. Re-emitting one through `toJson` and getting the same bytes back is therefore the
 * proof PR #5426's reviewer had to construct by hand — re-derived here on every run, for every point
 * of the series, instead of once per scorecard forever (#5428).
 *
 * Fail-closed on an empty directory (ADR 0092): a series with no member would pass this vacuously.
 */
describe("a freshly emitted scorecard needs no formatter pass", () => {
	const repoRoot = (): string => {
		let dir = import.meta.dirname;
		while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
			const up = dirname(dir);
			if (up === dir) throw new Error("could not locate the repo root from the test file");
			dir = up;
		}
		return dir;
	};

	const seriesDir = join(repoRoot(), SERIES_DIR);
	const members = readdirSync(seriesDir).filter(isSeriesFileName);

	it("finds committed series points to check", () => {
		expect(members.length).toBeGreaterThan(0);
	});

	it.each(members)("re-emits %s exactly as biome formatted it", (member) => {
		const committed = readFileSync(join(seriesDir, member), "utf8");
		const decoded = decodeCommittedScorecard(committed);
		if (Result.isFailure(decoded)) {
			throw new Error(`${member} is not a readable series point: ${decoded.failure.message}`);
		}
		expect(toJson(decoded.success)).toBe(committed);
	});
});

describe("the record is the source of a committed number", () => {
	it("commits exactly the aggregate the shipped reader validated", () => {
		const record = recordWith({});
		const readBack = readRecord(
			`eval: ${record.outcome} @ ${record.sha} — ${record.clause}\n\n\`\`\`json\n${JSON.stringify(record.payload)}\n\`\`\`\n`,
		);
		expect(readBack._tag).toBe("Found");
		if (readBack._tag !== "Found") return;
		const built = buildCommittedScorecard({
			recordedAt: "2026-08-11T01:02:03Z",
			records: [readBack.value],
		});
		if (built._tag !== "Scorecard") throw new Error("expected a scorecard");
		expect(built.scorecard.cells[0]?.passRate).toBe(readBack.value.payload.passRate);
		expect(built.scorecard.cells[0]?.source.sha).toBe(readBack.value.payload.sha);
	});
});
