import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {afterEach, beforeEach, vi} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {forgetAmbientToken} from "../io/gh-api.ts";
import {
	completeEnvelope,
	decodeWorkflowRuns,
	hasExactManifestMembers,
	type RunRecord,
	resolveCiIdentity,
	safeArtifactMembers,
	safeCentralDirectoryMembers,
	selectTrustedRun,
	selectUniqueCompleted,
} from "./ci-github.ts";
import type {LocalhostHarnessDeclaration} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const harness: LocalhostHarnessDeclaration = {
	id: "tuval",
	workflow: ".github/workflows/review-ui-localhost-evidence.yml",
	check: "review-ui localhost evidence / tuval",
	event: "pull_request_target",
	artifact: "review-ui-localhost-tuval",
	captureCommand: ["pnpm", "--filter", "tuval", "test:browser"],
	serverBuildCommand: ["pnpm", "--filter", "tuval", "build"],
	serverCommand: ["node", "server.mjs", "4173"],
	containerPort: 4173,
	readinessPattern: "ready (http://127.0.0.1:[0-9]+)",
	captureReadySelector: ".react-flow__node",
	surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
};

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
	id: 42,
	status: "completed",
	conclusion: "success",
	event: "pull_request_target",
	path: harness.workflow,
	repository: "kamp-us/phoenix",
	subjectHead: HEAD,
	title: `review-ui localhost evidence / tuval / PR #7190 / subject ${HEAD} / authority ${AUTHORITY_HEAD}`,
	checkSuiteId: 7,
	...overrides,
});

const select = (runs: readonly RunRecord[]) =>
	selectTrustedRun(runs, "kamp-us/phoenix", 7190, HEAD, AUTHORITY_HEAD, harness);

const runEnvelope = {
	id: 42,
	status: "completed",
	conclusion: "success",
	event: "pull_request_target",
	path: harness.workflow,
	repository: {full_name: "kamp-us/phoenix"},
	head_sha: HEAD,
	display_title: `review-ui localhost evidence / tuval / PR #7190 / subject ${HEAD} / authority ${AUTHORITY_HEAD}`,
	check_suite_id: 7,
};
const RUNS = /GET .*\/actions\/workflows\/review-ui-localhost-evidence\.yml\/runs/;
const CHECKS = /GET .*\/check-suites\/7\/check-runs/;
const ARTIFACTS = /GET .*\/actions\/runs\/42\/artifacts/;

const centralDirectory = (
	entries: ReadonlyArray<{readonly name: string; readonly mode: number}>,
): Uint8Array => {
	const encoder = new TextEncoder();
	const records = entries.map((entry) => {
		const name = encoder.encode(entry.name);
		const record = new Uint8Array(46 + name.length);
		const view = new DataView(record.buffer);
		view.setUint32(0, 0x02014b50, true);
		view.setUint16(4, 3 << 8, true);
		view.setUint16(28, name.length, true);
		view.setUint32(38, entry.mode << 16, true);
		record.set(name, 46);
		return record;
	});
	const centralSize = records.reduce((sum, record) => sum + record.length, 0);
	const archive = new Uint8Array(centralSize + 22);
	let offset = 0;
	for (const record of records) {
		archive.set(record, offset);
		offset += record.length;
	}
	const eocd = new DataView(archive.buffer, centralSize);
	eocd.setUint32(0, 0x06054b50, true);
	eocd.setUint16(8, entries.length, true);
	eocd.setUint16(10, entries.length, true);
	eocd.setUint32(12, centralSize, true);
	eocd.setUint32(16, 0, true);
	return archive;
};

beforeEach(() => {
	forgetAmbientToken();
	vi.stubEnv("GITHUB_TOKEN", "token");
});

afterEach(() => {
	vi.unstubAllEnvs();
	forgetAmbientToken();
});

describe("trusted localhost Actions provenance", () => {
	it("requires exhausted pagination and exact declared totals before selecting runs, checks, or artifacts", () => {
		for (const kind of ["workflow runs", "check runs", "artifacts"] as const) {
			assert.strictEqual(
				completeEnvelope({declared: 1, entries: [{}], exhausted: true}, kind)._tag,
				"Ok",
			);
			for (const incomplete of [
				{declared: 1, entries: [{}], exhausted: false},
				{declared: 2, entries: [{}], exhausted: true},
				{declared: 0, entries: [{}], exhausted: true},
			]) {
				assert.strictEqual(completeEnvelope(incomplete, kind)._tag, "RuntimeUnknown");
			}
		}
	});

	it("refuses inconsistent declared totals at each enumeration before reading or selecting the next leg", async () => {
		const completeRuns: Scripted = [
			RUNS,
			{status: 200, body: JSON.stringify({total_count: 1, workflow_runs: [runEnvelope]})},
		];
		const completeChecks: Scripted = [
			CHECKS,
			{
				status: 200,
				body: JSON.stringify({
					total_count: 1,
					check_runs: [{id: 9, name: harness.check, status: "completed", conclusion: "success"}],
				}),
			},
		];
		const inconsistent = [
			{
				script: [
					[
						RUNS,
						{status: 200, body: JSON.stringify({total_count: 2, workflow_runs: [runEnvelope]})},
					],
				] satisfies ReadonlyArray<Scripted>,
				unread: CHECKS,
			},
			{
				script: [
					completeRuns,
					[
						CHECKS,
						{
							status: 200,
							body: JSON.stringify({
								total_count: 2,
								check_runs: [
									{id: 9, name: harness.check, status: "completed", conclusion: "success"},
								],
							}),
						},
					],
				] satisfies ReadonlyArray<Scripted>,
				unread: ARTIFACTS,
			},
			{
				script: [
					completeRuns,
					completeChecks,
					[
						ARTIFACTS,
						{
							status: 200,
							body: JSON.stringify({
								total_count: 2,
								artifacts: [{id: 10, name: harness.artifact, expired: false}],
							}),
						},
					],
				] satisfies ReadonlyArray<Scripted>,
				unread: /this-leg-does-not-exist/,
			},
		];
		for (const testCase of inconsistent) {
			const seams = fakeSeams(testCase.script);
			const outcome = await Effect.runPromise(
				Effect.provide(
					resolveCiIdentity("kamp-us/phoenix", 7190, HEAD, AUTHORITY_HEAD, harness),
					seams.layer,
				),
			);
			assert.strictEqual(outcome._tag, "RuntimeUnknown");
			assert.isFalse(seams.requests.some((request) => testCase.unread.test(request)));
		}
	});

	it("keeps GitHub transport and token failures typed UNKNOWN", async () => {
		const transport = fakeSeams([[RUNS, {status: 503, body: "{}"}]]);
		const transportOutcome = await Effect.runPromise(
			Effect.provide(
				resolveCiIdentity("kamp-us/phoenix", 7190, HEAD, AUTHORITY_HEAD, harness),
				transport.layer,
			),
		);
		assert.strictEqual(transportOutcome._tag, "TransportUnknown");

		forgetAmbientToken();
		vi.stubEnv("GITHUB_TOKEN", "");
		vi.stubEnv("GH_TOKEN", "");
		const noToken = fakeSeams([]);
		const tokenOutcome = await Effect.runPromise(
			Effect.provide(
				resolveCiIdentity("kamp-us/phoenix", 7190, HEAD, AUTHORITY_HEAD, harness),
				noToken.layer,
			),
		);
		assert.strictEqual(tokenOutcome._tag, "TokenUnknown");
	});

	it("replays a recorded pull_request_target run whose head_sha is the PR head and associations are empty", () => {
		const decoded = decodeWorkflowRuns([
			{
				id: 33286961054,
				status: "completed",
				conclusion: "success",
				event: "pull_request_target",
				path: ".github/workflows/pr-cleanup.yml",
				head_sha: "9e9976e84b342aca1105f78b1e3b87815895cb5a",
				display_title:
					"chore: Clearing human:queue-stall buys one conclusive read and nothing grants more waits",
				check_suite_id: 90206922568,
				repository: {full_name: "kamp-us/phoenix"},
				pull_requests: [],
			},
		]);
		assert.strictEqual(decoded._tag, "Ok");
		if (decoded._tag === "Ok") {
			assert.strictEqual(decoded.value[0]?.subjectHead, "9e9976e84b342aca1105f78b1e3b87815895cb5a");
		}
	});

	it("refuses incomplete association fields instead of filtering malformed runs before selection", () => {
		for (const incomplete of [
			{...runEnvelope, path: undefined},
			{...runEnvelope, conclusion: 0},
			{...runEnvelope, repository: {}},
			{...runEnvelope, repository: {full_name: 7}},
		]) {
			assert.strictEqual(decodeWorkflowRuns([incomplete])._tag, "RuntimeUnknown");
		}
	});

	it("selects only the base-owned run title that binds PR, subject, and authority", () => {
		assert.strictEqual(select([run()])._tag, "Ok");
		for (const candidate of [
			run({path: ".github/workflows/other.yml"}),
			run({event: "pull_request"}),
			run({repository: "attacker/fork"}),
			run({subjectHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}),
			run({
				title: `review-ui localhost evidence / tuval / PR #1 / subject ${HEAD} / authority ${AUTHORITY_HEAD}`,
			}),
			run({
				title: `review-ui localhost evidence / tuval / PR #7190 / subject ${HEAD} / authority ${"b".repeat(40)}`,
			}),
			run({title: "review-ui localhost evidence / tuval / PR #7190 / short"}),
		]) {
			assert.strictEqual(select([candidate])._tag, "ProducerUnavailable");
		}
	});

	it("ignores a stale-authority run when a fresh matching event exists", () => {
		const stale = run({
			id: 41,
			title: `review-ui localhost evidence / tuval / PR #7190 / subject ${HEAD} / authority ${"b".repeat(40)}`,
		});
		const selected = select([stale, run()]);
		assert.strictEqual(selected._tag, "Ok");
		if (selected._tag === "Ok") assert.strictEqual(selected.value.id, 42);
	});

	it("types ambiguous, pending, failed, cancelled and action-required runs as proven unavailable", () => {
		assert.strictEqual(select([run(), run({id: 43})])._tag, "ProducerUnavailable");
		for (const candidate of [
			run({status: "queued", conclusion: null}),
			run({conclusion: "failure"}),
			run({conclusion: "cancelled"}),
			run({conclusion: "action_required"}),
		]) {
			assert.strictEqual(select([candidate])._tag, "ProducerUnavailable");
		}
	});

	it("requires exactly one correctly named successful check and one non-expired artifact", () => {
		for (const [kind, row] of [
			["check", {id: 1, name: "other", conclusion: "success"}],
			["check", {id: 1, name: "other", status: "completed", conclusion: 0}],
			["artifact", {id: 1, name: "other"}],
			["artifact", {id: 1, name: "other", expired: "false"}],
		] as const) {
			assert.strictEqual(selectUniqueCompleted([row], harness.check, kind)._tag, "RuntimeUnknown");
		}
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.check, status: "completed", conclusion: "success"}],
				harness.check,
				"check",
			)._tag,
			"Ok",
		);
		for (const checks of [
			[{id: 1, name: "wrong check", status: "completed", conclusion: "success"}],
			[
				{id: 1, name: harness.check, status: "completed", conclusion: "success"},
				{id: 2, name: harness.check, status: "completed", conclusion: "success"},
			],
			[{id: 1, name: harness.check, status: "completed", conclusion: "failure"}],
		]) {
			assert.strictEqual(
				selectUniqueCompleted(checks, harness.check, "check")._tag,
				"ProducerUnavailable",
			);
		}
		assert.strictEqual(
			selectUniqueCompleted(
				[
					{id: 1, name: harness.artifact, expired: false},
					{id: 2, name: harness.artifact, expired: false},
				],
				harness.artifact,
				"artifact",
			)._tag,
			"ProducerUnavailable",
		);
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.artifact, expired: false}],
				harness.artifact,
				"artifact",
			)._tag,
			"Ok",
		);
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.artifact, expired: true}],
				harness.artifact,
				"artifact",
			)._tag,
			"ProducerUnavailable",
		);
		for (const expired of [undefined, "false", 0]) {
			assert.strictEqual(
				selectUniqueCompleted(
					[{id: 1, name: harness.artifact, ...(expired === undefined ? {} : {expired})}],
					harness.artifact,
					"artifact",
				)._tag,
				"RuntimeUnknown",
			);
		}
	});

	it("rejects allowed-name symlinks and chained symlink entries from central-directory types", () => {
		const regular = 0o100644;
		const symlink = 0o120777;
		assert.deepStrictEqual(
			safeCentralDirectoryMembers(
				centralDirectory([
					{name: "manifest.json", mode: regular},
					{name: "captures/desktop.png", mode: regular},
				]),
			),
			["manifest.json", "captures/desktop.png"],
		);
		assert.isNull(
			safeCentralDirectoryMembers(
				centralDirectory([
					{name: "manifest.json", mode: regular},
					{name: "captures/desktop.png", mode: symlink},
				]),
			),
		);
		assert.isNull(
			safeCentralDirectoryMembers(
				centralDirectory([
					{name: "manifest.json", mode: symlink},
					{name: "captures/desktop.png", mode: symlink},
				]),
			),
		);
	});

	it("rejects missing, duplicate and traversal artifact members", () => {
		assert.deepStrictEqual(safeArtifactMembers("manifest.json\ncaptures/desktop.png\n"), [
			"manifest.json",
			"captures/desktop.png",
		]);
		assert.isNull(safeArtifactMembers("manifest.json\n../builder.png\n"));
		assert.isNull(safeArtifactMembers("manifest.json\nmanifest.json\n"));
		assert.isNull(safeArtifactMembers("captures/desktop.png\n"));
	});

	it("rejects every extra member not named by the positive manifest", () => {
		const manifest = JSON.stringify({
			schemaVersion: 1,
			source: "github-actions",
			repository: "kamp-us/phoenix",
			pr: 7190,
			head: HEAD,
			harness: "tuval",
			declarationSha256: "a".repeat(64),
			producer: {
				workflow: harness.workflow,
				check: harness.check,
				event: harness.event,
				runId: 42,
				artifact: harness.artifact,
				authorityHead: AUTHORITY_HEAD,
			},
			captures: [
				{
					surface: "desktop",
					route: "/",
					state: "desktop",
					path: "captures/desktop.png",
					width: 1280,
					height: 800,
					sha256: "b".repeat(64),
					pageErrors: {rows: [], more: 0},
					errorCoverage: {pageerror: "readable", consoleError: "readable"},
				},
			],
		});
		assert.isTrue(hasExactManifestMembers(["manifest.json", "captures/desktop.png"], manifest));
		assert.isFalse(hasExactManifestMembers(["manifest.json"], manifest));
		assert.isFalse(
			hasExactManifestMembers(
				["manifest.json", "captures/desktop.png", "captures/forged.png"],
				manifest,
			),
		);
	});
});
