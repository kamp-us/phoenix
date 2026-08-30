import {assert, describe, it} from "@effect/vitest";
import {
	type RunRecord,
	safeArtifactMembers,
	selectTrustedRun,
	selectUniqueCompleted,
} from "./ci-github.ts";
import type {LocalhostHarnessDeclaration} from "./localhost-evidence.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const harness: LocalhostHarnessDeclaration = {
	id: "tuval",
	workflow: ".github/workflows/review-ui-localhost-evidence.yml",
	check: "review-ui localhost evidence / tuval",
	event: "pull_request_target",
	artifact: "review-ui-localhost-tuval",
	captureCommand: ["pnpm", "--filter", "tuval", "test"],
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
	checkSuiteId: 7,
	pullNumbers: [7190],
	pullHeads: [HEAD],
	...overrides,
});

describe("trusted localhost Actions provenance", () => {
	it("selects one successful run only when workflow, event, repository, PR and exact head agree", () => {
		assert.strictEqual(
			selectTrustedRun([run()], "kamp-us/phoenix", 7190, HEAD, harness)._tag,
			"Ok",
		);
		for (const candidate of [
			run({path: ".github/workflows/other.yml"}),
			run({event: "pull_request"}),
			run({repository: "attacker/fork"}),
			run({pullNumbers: [1]}),
			run({pullHeads: [HEAD.slice(0, 8)]}),
		]) {
			assert.strictEqual(
				selectTrustedRun([candidate], "kamp-us/phoenix", 7190, HEAD, harness)._tag,
				"Failure",
			);
		}
	});

	it("refuses ambiguous, pending, failed, cancelled and action-required runs", () => {
		assert.strictEqual(
			selectTrustedRun([run(), run({id: 43})], "kamp-us/phoenix", 7190, HEAD, harness)._tag,
			"Failure",
		);
		for (const candidate of [
			run({status: "queued", conclusion: null}),
			run({conclusion: "failure"}),
			run({conclusion: "cancelled"}),
			run({conclusion: "action_required"}),
		]) {
			assert.strictEqual(
				selectTrustedRun([candidate], "kamp-us/phoenix", 7190, HEAD, harness)._tag,
				"Failure",
			);
		}
	});

	it("requires exactly one successful check and one non-expired artifact", () => {
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.check, status: "completed", conclusion: "success"}],
				harness.check,
				"check",
			)._tag,
			"Ok",
		);
		assert.strictEqual(
			selectUniqueCompleted(
				[{id: 1, name: harness.check, status: "completed", conclusion: "failure"}],
				harness.check,
				"check",
			)._tag,
			"Failure",
		);
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
});
