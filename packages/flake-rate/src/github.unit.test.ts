import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {decodeWorkflowRuns} from "./github.ts";

describe("decodeWorkflowRuns", () => {
	it("decodes the workflow-runs envelope into domain WorkflowRun[]", () =>
		Effect.gen(function* () {
			const raw = {
				workflow_runs: [
					{
						run_number: 865,
						run_attempt: 2,
						conclusion: "success",
						head_branch: "main",
						created_at: "2026-06-19T22:04:01Z",
					},
					{
						run_number: 875,
						run_attempt: 1,
						conclusion: "success",
						head_branch: "main",
						created_at: "2026-06-19T22:42:31Z",
					},
				],
			};
			const runs = yield* decodeWorkflowRuns(raw);
			assert.strictEqual(runs.length, 2);
			assert.strictEqual(runs[0]?.runNumber, 865);
			assert.strictEqual(runs[0]?.runAttempt, 2);
			assert.strictEqual(runs[0]?.conclusion, "success");
			assert.strictEqual(runs[1]?.runAttempt, 1);
		}).pipe(Effect.runPromise));

	it("normalizes a null head_branch to the empty string and keeps null conclusion", () =>
		Effect.gen(function* () {
			const runs = yield* decodeWorkflowRuns({
				workflow_runs: [
					{
						run_number: 1,
						run_attempt: 1,
						conclusion: null,
						head_branch: null,
						created_at: "2026-06-19T00:00:00Z",
					},
				],
			});
			assert.strictEqual(runs[0]?.headBranch, "");
			assert.strictEqual(runs[0]?.conclusion, null);
		}).pipe(Effect.runPromise));

	it("fails with a SchemaError on a structurally malformed envelope", () =>
		Effect.gen(function* () {
			const result = yield* Effect.result(decodeWorkflowRuns({not_runs: []}));
			assert.strictEqual(result._tag, "Failure");
		}).pipe(Effect.runPromise));
});
