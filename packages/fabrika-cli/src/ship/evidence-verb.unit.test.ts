import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readManifest, runEvidence} from "./evidence-verb.ts";
import {ENV, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const COMMIT = /^gh api repos\/o\/r\/commits\/[0-9a-f]+ --jq \.sha$/;
const WORKFLOW = /^gh api repos\/o\/r\/actions\/workflows\/run-evidence\.yml/;
const RUNS = /^gh api --paginate repos\/o\/r\/actions\/runs\?head_sha=/;
const ARTIFACTS = /^gh api --paginate repos\/o\/r\/actions\/runs\/\d+\/artifacts/;
const MKTEMP = /^mktemp -d$/;
const DOWNLOAD = /^sh -c gh api repos\/o\/r\/actions\/artifacts\/\d+\/zip/;
const MAGIC = /^sh -c head -c 2 /;
const UNZIP = /^sh -c unzip -p /;

const runsAt = (
	...rows: ReadonlyArray<{id: number; name: string; status: string; completedAt?: string | null}>
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: rows.length,
			workflow_runs: rows.map(({completedAt, ...row}) => ({
				...row,
				conclusion: "success",
				completed_at: completedAt === undefined ? new Date().toISOString() : completedAt,
			})),
		}),
	);

const artifactsFor = (
	...rows: ReadonlyArray<{id: number; name: string; expired?: boolean}>
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: rows.length,
			artifacts: rows.map((row) => ({...row, expired: row.expired ?? false})),
		}),
	);

const manifest = (commit: string, checks: ReadonlyArray<{name: string; status: string}>): string =>
	JSON.stringify({schemaVersion: 1, commit, checks});

/**
 * A manifest in the shape the real producer publishes: `crabbox-manifest`'s `deriveChecks` writes
 * `{name, status: "pass" | "fail", exitCode}` per command, and the `run-evidence` workflow appends
 * `bundle-node-core-free` in the same words.
 */
const producerManifest = (commit: string): string =>
	JSON.stringify({
		schemaVersion: 1,
		commit,
		run: {producer: "crabbox", timestamp: "2026-07-25T04:57:44Z", environment: "ci"},
		checks: [
			{name: "run", status: "pass", exitCode: 0},
			{name: "bundle-node-core-free", status: "pass", exitCode: 0},
		],
		tests: {total: 2362, passed: 2362, failed: 0, skipped: 0, failures: []},
		logs: {ref: "run-log"},
	});

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runEvidence({...options, ...overrides}), fakeShell(script).layer),
	);

const upToArtifact: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[PULL, pull()],
	[COMMIT, okOut(HEAD)],
	[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
	[RUNS, runsAt({id: 9182736450, name: "run-evidence", status: "completed"})],
	[ARTIFACTS, artifactsFor({id: 2211334455, name: "run-evidence"})],
	[MKTEMP, okOut("/scratch/x")],
	[DOWNLOAD, okOut("")],
	[MAGIC, okOut("PK")],
];

describe("readManifest", () => {
	it("reads `checks[].status` as a STRING — a boolean-shaped parser reads everything falsy (#4392)", () => {
		expect(readManifest(manifest(HEAD, [{name: "unit", status: "pass"}]))?.checks).toEqual([
			{name: "unit", status: "pass"},
		]);
	});

	it("refuses a manifest whose checks carry a boolean instead", () => {
		expect(
			readManifest(
				JSON.stringify({schemaVersion: 1, commit: HEAD, checks: [{name: "u", pass: true}]}),
			),
		).toBeNull();
	});
});

describe("runEvidence", () => {
	it("reports present with the lookup evidence and one line per manifest check", async () => {
		const out = await run([
			...upToArtifact,
			[
				UNZIP,
				okOut(
					manifest(HEAD, [
						{name: "typecheck", status: "pass"},
						{name: "unit", status: "pass"},
					]),
				),
			],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`evidence\tpresent\t${HEAD}`,
				"lookup\trun:9182736450\tartifact:2211334455\tstatus:completed",
				"check\ttypecheck\tpass",
				"check\tunit\tpass",
				"",
			].join("\n"),
		);
	});

	// #5563: the consumer read the bundle against GitHub's conclusion vocabulary, which the producer
	// never writes, so every real bundle read `failed` and no PR could ship on green evidence.
	it("reports present for a manifest in the producer's own published shape", async () => {
		const out = await run([...upToArtifact, [UNZIP, okOut(producerManifest(HEAD))]]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tpresent\t${HEAD}`);
	});

	it("reports failed for a check carrying GitHub's `success` — an unknown word is not passing", async () => {
		const out = await run([
			...upToArtifact,
			[UNZIP, okOut(manifest(HEAD, [{name: "unit", status: "success"}]))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tfailed\t${HEAD}`);
	});

	it("reports pending for an in-flight producer run — pending is NOT absent (#3913)", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
			[RUNS, runsAt({id: 9182736999, name: "run-evidence", status: "in_progress"})],
		]);
		expect(out.stdout).toBe(
			[
				`evidence\tpending\t${HEAD}`,
				"lookup\trun:9182736999\tartifact:-\tstatus:in_progress",
				"",
			].join("\n"),
		);
	});

	it("reports absent on the foreign-repo degradation, proven by a SUCCESSFUL inventory read", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tabsent\t${HEAD}`);
	});

	// Clause 6: "completed, zero artifacts" is two facts in one shape. The 120s window against the
	// local clock is what separates a listing lag from a producer that published nothing.
	it("reports pending for a JUST-completed run with zero artifacts — listing lag, not a CI gap", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
			[RUNS, runsAt({id: 9182736450, name: "run-evidence", status: "completed"})],
			[ARTIFACTS, artifactsFor()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tpending\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("listing lag: pending."))).toBe(true);
	});

	it("reports absent once that run is older than the window — the producer published nothing", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
			[
				RUNS,
				runsAt({
					id: 9182736450,
					name: "run-evidence",
					status: "completed",
					completedAt: "2026-08-08T00:00:00Z",
				}),
			],
			[ARTIFACTS, artifactsFor()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tabsent\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("published nothing: absent."))).toBe(true);
	});

	it("reports absent when the run never reports a completion time at all", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
			[
				RUNS,
				runsAt({id: 9182736450, name: "run-evidence", status: "completed", completedAt: null}),
			],
			[ARTIFACTS, artifactsFor()],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tabsent\t${HEAD}`);
	});

	// Clause 5: `failed` is the most DEFINITE answer this verb has; `unknown` means the opposite.
	it("reports failed for a bundle that binds this head and attests a failing run", async () => {
		const out = await run([
			...upToArtifact,
			[UNZIP, okOut(manifest(HEAD, [{name: "unit", status: "fail"}]))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tfailed\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("it attests a run, not a passing one"))).toBe(
			true,
		);
	});

	it("reports unknown when the bundle attests another tree", async () => {
		const out = await run([...upToArtifact, [UNZIP, okOut(manifest(OTHER_HEAD, []))]]);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tunknown\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("is not evidence about this one"))).toBe(true);
	});

	it("refuses a body that is not a zip on 11 — a 503 saved as .zip is not a bundle (#3716)", async () => {
		const out = await run([
			...upToArtifact.filter(([pattern]) => pattern !== MAGIC),
			[MAGIC, okOut("<h")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('whether a bundle exists is UNKNOWN, never "absent"');
	});

	it("refuses an unreadable run list on 11, never `absent`", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, okOut(HEAD)],
			[WORKFLOW, okOut(".github/workflows/run-evidence.yml")],
			[RUNS, errOut("gh: Service unavailable (HTTP 503)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run([
			[PULL, pull()],
			[COMMIT, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
