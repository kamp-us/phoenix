import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readManifest, runEvidence} from "./evidence-verb.ts";
import {ENV, HEAD, OTHER_HEAD, pull} from "./fixtures.test-support.ts";

/** The scratch and unzip legs stay spawns; the two GitHub reads are served. */
const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const COMMIT = /^GET \S+\/repos\/o\/r\/commits\/[0-9a-f]+$/;
const MKTEMP = /^mktemp -d$/;
const UNZIP = /^sh -c unzip -p /;

/** Everything the verb reads off GitHub now goes over HTTP. */
const WORKFLOW =
	/^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/workflows\/run-evidence\.yml$/;
const RUNS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\?head_sha=/;
const ARTIFACTS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\/\d+\/artifacts/;
const ZIP = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/artifacts\/\d+\/zip$/;

/**
 * A real directory, because `fetchManifest` writes the fetched bytes there for real — the download
 * no longer goes through a shelled redirect, so a fictional `mktemp -d` path would fail the write.
 */
const scratch = (): string => mkdtempSync(join(tmpdir(), "fabrika-test-"));

const runsAt = (
	...rows: ReadonlyArray<{
		id: number;
		name: string;
		status: string;
		conclusion?: string;
		completedAt?: string | null;
	}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		total_count: rows.length,
		workflow_runs: rows.map(({completedAt, conclusion, ...row}) => ({
			...row,
			workflow_id: row.id,
			check_suite_id: row.id,
			conclusion: conclusion ?? "success",
			completed_at: completedAt === undefined ? new Date().toISOString() : completedAt,
		})),
	}),
});

/** The shape GitHub reports for a run parked on a bot-authored branch: completed, never started. */
const PARKED_RUN = {
	id: 9182730001,
	name: "run-evidence",
	status: "completed",
	conclusion: "action_required",
	completedAt: "2026-08-08T00:00:00Z",
} as const;

const artifactsFor = (
	...rows: ReadonlyArray<{id: number; name: string; expired?: boolean}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		total_count: rows.length,
		artifacts: rows.map((row) => ({...row, expired: row.expired ?? false})),
	}),
});

/** The bundle's bytes. Only the `PK` magic number is read in memory before the write. */
const zipBody = (): HttpReply => ({status: 200, body: "PKfabrika-test-bundle"});

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
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runEvidence({...options, ...overrides}), fakeSeams([...script, ...http]).layer),
	);

const readsUpToArtifact = (): ReadonlyArray<Scripted> => [
	[PULL, {status: 200, body: pull().stdout}],
	[COMMIT, {status: 200, body: JSON.stringify({sha: HEAD})}],
	[MKTEMP, okOut(scratch())],
];

const HTTP_UP_TO_ARTIFACT: ReadonlyArray<Scripted> = [
	[WORKFLOW, {status: 200, body: JSON.stringify({path: ".github/workflows/run-evidence.yml"})}],
	[RUNS, runsAt({id: 9182736450, name: "run-evidence", status: "completed"})],
	[ARTIFACTS, artifactsFor({id: 2211334455, name: "run-evidence"})],
	[ZIP, zipBody()],
];

/** The rows for a run that never reaches the download. */
const HEAD_READS: ReadonlyArray<Scripted> = [
	[PULL, {status: 200, body: pull().stdout}],
	[COMMIT, {status: 200, body: JSON.stringify({sha: HEAD})}],
];

const WORKFLOW_PRESENT: Scripted = [
	WORKFLOW,
	{status: 200, body: JSON.stringify({path: ".github/workflows/run-evidence.yml"})},
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
	it("reports present with the lookup evidence and the manifest checks as a status tally", async () => {
		const out = await run(
			[
				...readsUpToArtifact(),
				[
					UNZIP,
					okOut(
						manifest(HEAD, [
							{name: "typecheck", status: "pass"},
							{name: "unit", status: "pass"},
						]),
					),
				],
			],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`evidence\tpresent\t${HEAD}`,
				"lookup\trun:9182736450\tartifact:2211334455\tstatus:completed",
				"check\tpass\t2",
				"",
			].join("\n"),
		);
	});

	// #6759: a Release PR's head carries both the parked `pull_request` run and the dispatched one,
	// and GitHub's return order for `runs?head_sha=` is undocumented. Taking the first match would
	// read `absent` at a head whose bundle exists.
	it("picks the run that ran over a parked one, whatever order GitHub lists them in", async () => {
		const out = await run(
			[...readsUpToArtifact(), [UNZIP, okOut(producerManifest(HEAD))]],
			[
				WORKFLOW_PRESENT,
				[RUNS, runsAt(PARKED_RUN, {id: 9182736450, name: "run-evidence", status: "completed"})],
				[ARTIFACTS, artifactsFor({id: 2211334455, name: "run-evidence"})],
				[ZIP, zipBody()],
			],
		);
		expect(out.stdout).toContain(`evidence\tpresent\t${HEAD}`);
		expect(out.stdout).toContain("lookup\trun:9182736450\tartifact:2211334455");
	});

	it("names the parking when a parked run is the only one at the head", async () => {
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
			[RUNS, runsAt(PARKED_RUN)],
			[ARTIFACTS, artifactsFor()],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tabsent\t${HEAD}`);
		expect(out.stdout).toContain(`lookup\trun:${PARKED_RUN.id}`);
		expect(out.stderr.some((line) => line.includes("parked at action_required"))).toBe(true);
	});

	// ADR 0308: `checks` is an evidence-array, so the manifest's rows collapse to a status tally. The
	// names behind a non-passing tally stay readable — the verb already lists them on stderr.
	it("tallies the manifest's checks by status instead of printing a row per check", async () => {
		const out = await run(
			[
				...readsUpToArtifact(),
				[
					UNZIP,
					okOut(
						manifest(HEAD, [
							{name: "typecheck", status: "pass"},
							{name: "unit", status: "fail"},
							{name: "lint", status: "fail"},
						]),
					),
				],
			],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tfailed\t${HEAD}`);
		expect(out.stdout).toContain("check\tfail\t2");
		expect(out.stdout).toContain("check\tpass\t1");
		expect(out.stdout).not.toContain("typecheck");
		expect(out.stderr.join("\n")).toContain("unit, lint");
	});

	it("mirrors the same collapsed tally into the --json payload", async () => {
		const out = await run(
			[
				...readsUpToArtifact(),
				[
					UNZIP,
					okOut(
						manifest(HEAD, [
							{name: "typecheck", status: "pass"},
							{name: "unit", status: "pass"},
						]),
					),
				],
			],
			HTTP_UP_TO_ARTIFACT,
			{json: true},
		);
		expect(JSON.parse(out.stdout).checks).toEqual({pass: 2});
	});

	// #5563: the consumer read the bundle against GitHub's conclusion vocabulary, which the producer
	// never writes, so every real bundle read `failed` and no PR could ship on green evidence.
	it("reports present for a manifest in the producer's own published shape", async () => {
		const out = await run(
			[...readsUpToArtifact(), [UNZIP, okOut(producerManifest(HEAD))]],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tpresent\t${HEAD}`);
	});

	it("reports failed for a check carrying GitHub's `success` — an unknown word is not passing", async () => {
		const out = await run(
			[...readsUpToArtifact(), [UNZIP, okOut(manifest(HEAD, [{name: "unit", status: "success"}]))]],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tfailed\t${HEAD}`);
	});

	it("reports pending for an in-flight producer run — pending is NOT absent (#3913)", async () => {
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
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
		const out = await run(HEAD_READS, [[WORKFLOW, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tabsent\t${HEAD}`);
	});

	// Clause 6: "completed, zero artifacts" is two facts in one shape. The 120s window against the
	// local clock is what separates a listing lag from a producer that published nothing.
	it("reports pending for a JUST-completed run with zero artifacts — listing lag, not a CI gap", async () => {
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
			[RUNS, runsAt({id: 9182736450, name: "run-evidence", status: "completed"})],
			[ARTIFACTS, artifactsFor()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tpending\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("listing lag: pending."))).toBe(true);
	});

	it("reports absent once that run is older than the window — the producer published nothing", async () => {
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
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
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
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
		const out = await run(
			[...readsUpToArtifact(), [UNZIP, okOut(manifest(HEAD, [{name: "unit", status: "fail"}]))]],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tfailed\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("it attests a run, not a passing one"))).toBe(
			true,
		);
	});

	it("reports unknown when the bundle attests another tree", async () => {
		const out = await run(
			[...readsUpToArtifact(), [UNZIP, okOut(manifest(OTHER_HEAD, []))]],
			HTTP_UP_TO_ARTIFACT,
		);
		expect(out.stdout.split("\n")[0]).toBe(`evidence\tunknown\t${HEAD}`);
		expect(out.stderr.some((line) => line.includes("is not evidence about this one"))).toBe(true);
	});

	it("refuses a body that is not a zip on 11 — a 503 saved as .zip is not a bundle (#3716)", async () => {
		const out = await run(readsUpToArtifact(), [
			...HTTP_UP_TO_ARTIFACT.filter(([pattern]) => pattern !== ZIP),
			[ZIP, {status: 200, body: "<html>service unavailable</html>"}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the fetched artifact is not a zip");
		expect(out.stderr.at(-1)).toContain('whether a bundle exists is UNKNOWN, never "absent"');
	});

	it("refuses an unreadable run list on 11, never `absent`", async () => {
		const out = await run(HEAD_READS, [
			WORKFLOW_PRESENT,
			[RUNS, {status: 503, body: '{"message":"Service unavailable"}'}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a --sha proven absent on 7", async () => {
		const out = await run(
			[
				[PULL, {status: 200, body: pull().stdout}],
				[COMMIT, {status: 404, body: '{"message":"Not Found"}'}],
			],
			[],
		);
		expect(out.code).toBe(ZERO_SCOPE);
	});
});
