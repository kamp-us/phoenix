/**
 * The identity sidecar's tier: does a run's session id survive from the axis to a durable file, and
 * can a reader go from a recorded verdict back to the session that produced it?
 *
 * The load-bearing test is the round-trip one — the axis is driven with a stub that mints a session
 * per run exactly as the graded command does, the record is built from the same runs, and the two are
 * checked against each other. That is the property #5439 is about; everything else here is the
 * refusal surface that keeps a wrong manifest from being written.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {EvalCaseBlock} from "../wire/eval-record.ts";
import {
	buildEvalRecord,
	type GradableCase,
	perRunToken,
	type RunVerdict,
	runGradedAxis,
} from "./graded-axis.ts";
import {
	type RunIdentity,
	type RunManifest,
	runManifestDisagreement,
	runManifestPathFor,
	toJson,
} from "./run-manifest.ts";

const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";
const MODEL = "claude-opus-4-8";

const caseOf = (id: number): GradableCase => ({
	id,
	prompt: "File a report for the guard that reds on zero scope.",
	expectedOutput: null,
	expectations: ["it files exactly one issue"],
	files: [`evals/cases/eval-${id}.md`],
});

const pass: RunVerdict = {_tag: "Verdict", passed: true};
const fail: RunVerdict = {_tag: "Verdict", passed: false};
const dead: RunVerdict = {_tag: "NoVerdict", reason: "timed-out"};

const rowOf = (over: Partial<RunIdentity> = {}): RunIdentity => ({
	caseId: 1,
	run: 1,
	sessionId: "6f1b0930-5c4d-4e1f-8a7b-8c9d03135b91",
	model: MODEL,
	verdict: "pass",
	...over,
});

const manifestOf = (runs: ReadonlyArray<RunIdentity>): RunManifest => ({
	sha: HEAD,
	recordedAt: "2026-08-12T18:26:39.118Z",
	cell: {stage: "build", surface: null, model: MODEL},
	runs,
});

const blockOf = (over: Partial<EvalCaseBlock> = {}): EvalCaseBlock => ({
	caseId: 1,
	verdict: "pass",
	runs: 1,
	passed: 1,
	noVerdict: 0,
	dispersion: 0,
	perRun: ["pass"],
	...over,
});

/**
 * The graded command's own wiring, minus the spawn: one session per run, pushed on every outcome.
 * Driving the real axis is what makes this a seam test rather than a restatement of the shapes.
 */
const runWithIdentities = (args: {
	readonly cases: ReadonlyArray<GradableCase>;
	readonly script: ReadonlyArray<RunVerdict>;
}) => {
	const identities: Array<RunIdentity> = [];
	let minted = 0;
	const results = Effect.runSync(
		runGradedAxis({
			cases: args.cases,
			runOnce: ({evalCase, run}) =>
				Effect.sync(() => {
					minted += 1;
					const verdict = args.script[(run - 1) % args.script.length] ?? fail;
					identities.push({
						caseId: evalCase.id,
						run,
						sessionId: `session-${minted}`,
						model: MODEL,
						verdict: perRunToken(verdict),
					});
					return verdict;
				}),
		}),
	);
	return {identities, results};
};

describe("the manifest a graded run leaves beside its record", () => {
	it("names a distinct session for every run of every case, and agrees with the record", () => {
		const {identities, results} = runWithIdentities({
			cases: [caseOf(1), caseOf(2)],
			script: [pass, pass, fail, dead, pass],
		});
		const built = buildEvalRecord({
			sha: HEAD,
			recordedAt: "2026-08-12T18:26:39.118Z",
			cell: {stage: "build", surface: null, model: MODEL},
			pins: {model: MODEL, cli: "2.1.227 (Claude Code)", harness: "0.1.0"},
			results,
		});
		if (built._tag !== "Record") throw new Error(built.reason);

		expect(identities).toHaveLength(10);
		expect(new Set(identities.map((row) => row.sessionId)).size).toBe(10);
		expect(runManifestDisagreement(manifestOf(identities), built.record.payload.cases)).toBeNull();

		// The property the issue is about: a recorded token is traceable back to one session, without
		// inferring run order from artifact mtimes.
		const block = built.record.payload.cases[1];
		if (block === undefined) throw new Error("the record carries no second case");
		const third = identities.find((row) => row.caseId === block.caseId && row.run === 3);
		expect(third?.verdict).toBe(block.perRun[2]);
		expect(third?.sessionId).toBe("session-8");
	});

	it("keeps the row of a run that died — the run needing a name most is the one that produced nothing", () => {
		const {identities} = runWithIdentities({cases: [caseOf(1)], script: [dead]});
		expect(identities.map((row) => row.verdict)).toEqual(Array(5).fill("no-verdict:timed-out"));
		expect(identities.every((row) => row.sessionId !== "")).toBe(true);
	});
});

describe("the manifest is checked against the record, never trusted", () => {
	it("agrees when every run is named once, in order, with the token the record carries", () => {
		const runs = [rowOf({run: 1}), rowOf({run: 2, verdict: "fail"})];
		const block = blockOf({verdict: "fail", runs: 2, passed: 1, perRun: ["pass", "fail"]});
		expect(runManifestDisagreement(manifestOf(runs), [block])).toBeNull();
	});

	it("refuses a manifest naming no run against a record that carries cases (ADR 0092)", () => {
		expect(runManifestDisagreement(manifestOf([]), [blockOf()])).toMatch(/names no run/);
	});

	it("refuses a short manifest — a dropped run is the gap this file exists to close", () => {
		const block = blockOf({runs: 2, passed: 2, perRun: ["pass", "pass"]});
		expect(runManifestDisagreement(manifestOf([rowOf()]), [block])).toMatch(/names 1/);
	});

	it("refuses a run numbered outside 1…runs", () => {
		const runs = [rowOf({run: 1}), rowOf({run: 3})];
		const block = blockOf({runs: 2, passed: 2, perRun: ["pass", "pass"]});
		expect(runManifestDisagreement(manifestOf(runs), [block])).toMatch(/numbered 1, 3/);
	});

	it("refuses a row whose verdict contradicts the record's own token", () => {
		const block = blockOf({verdict: "fail", passed: 0, perRun: ["fail"]});
		expect(runManifestDisagreement(manifestOf([rowOf()]), [block])).toMatch(/`pass`.*`fail`/);
	});

	it("refuses an unnamed session and a case the record never graded", () => {
		expect(runManifestDisagreement(manifestOf([rowOf({sessionId: "  "})]), [blockOf()])).toMatch(
			/names no session/,
		);
		expect(runManifestDisagreement(manifestOf([rowOf({caseId: 9})]), [blockOf()])).toMatch(
			/case 9, which the record does not/,
		);
	});
});

describe("where the manifest lands and what it looks like", () => {
	it("sits beside the record's own bytes, whatever extension they carry", () => {
		expect(runManifestPathFor("record.md")).toBe("record.runs.json");
		expect(runManifestPathFor("reports/2026-08-12.json")).toBe("reports/2026-08-12.runs.json");
		expect(runManifestPathFor("some.dir/record")).toBe("some.dir/record.runs.json");
	});

	it("is tab-indented with a trailing newline, and carries no machine-local path", () => {
		const bytes = toJson(manifestOf([rowOf()]));
		expect(bytes.startsWith("{\n\t")).toBe(true);
		expect(bytes.endsWith("}\n")).toBe(true);
		expect(Object.keys(JSON.parse(bytes).runs[0])).toEqual([
			"caseId",
			"run",
			"sessionId",
			"model",
			"verdict",
		]);
	});
});
