/**
 * `ci evidence`, ported from `pipeline-cli crabbox-manifest` (#6099) — the commit-stamp binding
 * ADR 0054 §1 rests on, and the refusals that keep a half-formed manifest off disk.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell} from "../fakes.test-support.ts";
import {MALFORMED_DOCUMENT, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	failingJUnit,
	failingRunSummary,
	passingRunSummary,
} from "./crabbox-fixtures.test-support.ts";
import {type EvidenceOptions, runCiEvidence} from "./evidence-verb.ts";

const SUMMARY = "/repo/summary.json";
const JUNIT = "/repo/junit.xml";
const HEAD = "a".repeat(40);

const defaults: EvidenceOptions = {
	runSummary: SUMMARY,
	junit: null,
	logs: "crabbox:stdout",
	commit: HEAD,
	runUrl: null,
	environment: null,
	output: null,
	extraChecks: null,
};

const run = (
	files: Readonly<Record<string, string>>,
	over: Partial<EvidenceOptions> = {},
	headSha: string | null = HEAD,
) => {
	const fs = fakeFs({files});
	const shell = fakeShell(
		headSha === null
			? []
			: [[/git rev-parse/, {ok: true as const, stdout: `${headSha}\n`, reason: ""}]],
	);
	return Effect.runPromise(
		Effect.provide(runCiEvidence({...defaults, ...over}), Layer.mergeAll(fs.layer, shell.layer)),
	).then((outcome) => ({outcome, written: fs.written}));
};

const summaryFile = (summary: unknown) => ({[SUMMARY]: JSON.stringify(summary)});

describe("runCiEvidence", () => {
	it("stamps --commit and folds each crabbox command into checks[]", async () => {
		const {outcome} = await run(summaryFile(passingRunSummary()));
		expect(outcome.code).toBe(0);
		const manifest = JSON.parse(outcome.stdout);
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.commit).toBe(HEAD);
		expect(manifest.checks.map((c: {name: string}) => c.name)).toEqual([
			"typecheck",
			"lint",
			"test",
		]);
		expect(manifest.checks.every((c: {status: string}) => c.status === "pass")).toBe(true);
	});

	it("carries a failed command through as a failed check", async () => {
		const {outcome} = await run(summaryFile(failingRunSummary()));
		const manifest = JSON.parse(outcome.stdout);
		expect(manifest.checks.find((c: {name: string}) => c.name === "test").status).toBe("fail");
	});

	it("folds the JUnit rollup in when --junit is given", async () => {
		const {outcome} = await run(
			{...summaryFile(passingRunSummary()), [JUNIT]: failingJUnit},
			{junit: JUNIT},
		);
		expect(JSON.parse(outcome.stdout).tests.failed).toBe(1);
	});

	it("resolves HEAD when no --commit is given", async () => {
		const {outcome} = await run(summaryFile(passingRunSummary()), {commit: null});
		expect(JSON.parse(outcome.stdout).commit).toBe(HEAD);
	});

	it("refuses rather than stamping a blank commit when HEAD cannot be resolved", async () => {
		const {outcome, written} = await run(summaryFile(passingRunSummary()), {commit: null}, null);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
	});

	it("writes to --output and keeps stdout empty", async () => {
		const {outcome, written} = await run(summaryFile(passingRunSummary()), {
			output: "/repo/bundle/manifest.json",
		});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("");
		expect(JSON.parse(written.get("/repo/bundle/manifest.json") ?? "{}").commit).toBe(HEAD);
	});

	it("refuses a run-summary that is not a run summary, writing nothing", async () => {
		const {outcome, written} = await run(summaryFile({nope: true}), {
			output: "/repo/bundle/manifest.json",
		});
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(written.size).toBe(0);
	});

	it("refuses an unreadable run-summary as UNKNOWN", async () => {
		const {outcome} = await run({});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("folds an --extra-checks file into checks[], and refuses one of the wrong shape", async () => {
		const good = await run(
			{
				...summaryFile(passingRunSummary()),
				"/repo/extra.json": JSON.stringify({
					name: "bundle-node-core-free",
					status: "pass",
					exitCode: 0,
				}),
			},
			{extraChecks: "/repo/extra.json"},
		);
		expect(
			JSON.parse(good.outcome.stdout).checks.some(
				(c: {name: string}) => c.name === "bundle-node-core-free",
			),
		).toBe(true);

		const bad = await run(
			{...summaryFile(passingRunSummary()), "/repo/extra.json": '{"name":42}'},
			{extraChecks: "/repo/extra.json"},
		);
		expect(bad.outcome.code).toBe(MALFORMED_DOCUMENT);
	});
});
