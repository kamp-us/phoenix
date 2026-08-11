/**
 * The series directory is shared, and a neighbour in it may not take the series down.
 *
 * `claude-plugins/fabrika/reports/eval/` holds the committed scorecards *and* the dated cost
 * baselines of #4679, so `trend` and `churn` meet foreign JSON on the default path. Asserted through
 * the real process because the defect was in the directory read, not in a core: a unit test on
 * `isSeriesFileName` proves the rule, only a run proves the two verbs consult it.
 *
 * The counter-case is the other half of the fix — a file named as a *member* that does not decode is
 * still a hard refusal, so this cannot pass by having quietly skipped everything.
 */
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import type {EvalRecord} from "../wire/eval-record.ts";
import {MALFORMED_DOCUMENT} from "./codes.ts";
import {buildCommittedScorecard, toJson} from "./committed-scorecard.ts";
import {buildEvalRecord} from "./graded-axis.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";
const MODEL = "opus-4.8";

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whichever install a root pins.
 *
 * `spawnSync` rather than the group's usual `execFileSync` wrapper because these assertions read
 * stderr on a **succeeding** run — the skip notice rides there while the verb exits `0`, and
 * `execFileSync` only surfaces stderr by throwing.
 */
const fabrika = (...args: ReadonlyArray<string>): Run => {
	const run = spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: {...process.env, FABRIKA_SKIP_INFER: "1"},
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? ""};
};

const recordAt = (recordedAt: string): EvalRecord => {
	const built = buildEvalRecord({
		sha: HEAD,
		recordedAt,
		cell: {stage: "review", surface: "skill", model: MODEL},
		pins: {model: MODEL, cli: "2.1.220", harness: "0.1.0"},
		results: [
			{
				caseId: 1,
				verdict: "pass",
				runs: 5,
				passed: 5,
				noVerdict: 0,
				dispersion: 0,
				perRun: Array.from({length: 5}, () => "pass"),
			},
		],
		noMeasurement: "the set carries no graded case",
	});
	if (built._tag !== "Record") throw new Error(`fixture is unusable: ${built.reason}`);
	return built.record;
};

const recordBody = (record: EvalRecord): string =>
	`eval: ${record.outcome} @ ${record.sha} — ${record.clause}\n\n\`\`\`json\n${JSON.stringify(record.payload)}\n\`\`\`\n`;

/** A series directory holding one real point, one foreign artifact, plus a record file to adjudicate. */
const seriesWithNeighbour = (): {readonly dir: string; readonly recordPath: string} => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-series-"));
	const record = recordAt("2026-08-11T00:00:00Z");
	const built = buildCommittedScorecard({recordedAt: "2026-08-11T01:02:03Z", records: [record]});
	if (built._tag !== "Scorecard") throw new Error("fixture is unusable");
	writeFileSync(join(root, "2026-08-11.json"), toJson(built.scorecard));
	// The real neighbour, byte-shaped like #5404's committed artifact: valid JSON, not a scorecard.
	writeFileSync(
		join(root, "baseline-v1-2026-08-11.json"),
		`${JSON.stringify({suite: "v1", pins: {model: MODEL}, runs: 12}, null, 2)}\n`,
	);
	const recordPath = join(root, "record.md");
	writeFileSync(recordPath, recordBody(recordAt("2026-08-12T00:00:00Z")));
	return {dir: root, recordPath};
};

describe("a foreign JSON file in the series directory", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("does not take `eval trend` down, and is named on stderr", () => {
		const {dir} = seriesWithNeighbour();
		const run = fabrika("eval", "trend", "--series-dir", dir, "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).not.toMatch(/is not a committable scorecard/);
		expect(run.stderr).toContain("baseline-v1-2026-08-11.json");
		// The real point is still read: skipping the neighbour must not skip the series.
		expect(run.stdout).toContain("review");
	});

	it("does not take `eval churn` down", () => {
		const {dir, recordPath} = seriesWithNeighbour();
		const run = fabrika(
			"eval",
			"churn",
			"--model",
			MODEL,
			"--record",
			recordPath,
			"--series-dir",
			dir,
			"--json",
		);
		expect(run.code).toBe(0);
		expect(run.stderr).not.toMatch(/is not a committable scorecard/);
	});

	// The other half: the skip is by NAME, not by "whatever failed to decode". A corrupt point of the
	// series is still a hard refusal, or the fix would have silenced the signal instead of scoping it.
	it("does not make a corrupt series point silently skippable", () => {
		const {dir} = seriesWithNeighbour();
		writeFileSync(join(dir, "2026-08-12.json"), `${JSON.stringify({not: "a scorecard"})}\n`);
		const run = fabrika("eval", "trend", "--series-dir", dir, "--json");
		expect(run.code).toBe(MALFORMED_DOCUMENT);
		expect(run.stderr).toContain("is not a committable scorecard");
	});
});
