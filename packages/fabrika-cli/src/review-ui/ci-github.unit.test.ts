import {assert, describe, it} from "@effect/vitest";
import {
	decodeWorkflowRuns,
	hasExactManifestMembers,
	type RunRecord,
	safeArtifactMembers,
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
	captureCommand: ["pnpm", "--filter", "tuval", "test"],
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

describe("trusted localhost Actions provenance", () => {
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
			assert.strictEqual(select([candidate])._tag, "Failure");
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

	it("refuses ambiguous, pending, failed, cancelled and action-required runs", () => {
		assert.strictEqual(select([run(), run({id: 43})])._tag, "Failure");
		for (const candidate of [
			run({status: "queued", conclusion: null}),
			run({conclusion: "failure"}),
			run({conclusion: "cancelled"}),
			run({conclusion: "action_required"}),
		]) {
			assert.strictEqual(select([candidate])._tag, "Failure");
		}
	});

	it("requires exactly one correctly named successful check and one non-expired artifact", () => {
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
			assert.strictEqual(selectUniqueCompleted(checks, harness.check, "check")._tag, "Failure");
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
			"Failure",
		);
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.artifact, expired: false}],
				harness.artifact,
				"artifact",
			)._tag,
			"Ok",
		);
		for (const expired of [true, undefined, "false", 0]) {
			assert.strictEqual(
				selectUniqueCompleted(
					[{id: 1, name: harness.artifact, ...(expired === undefined ? {} : {expired})}],
					harness.artifact,
					"artifact",
				)._tag,
				"Failure",
			);
		}
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
