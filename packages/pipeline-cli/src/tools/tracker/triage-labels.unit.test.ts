import {assert, describe, it} from "@effect/vitest";
import {desiredLabels, supersededLabels} from "./triage-labels.ts";

const TRIAGED = {type: "bug", priority: "p2", status: "triaged"} as const;

describe("desiredLabels", () => {
	it("is exactly one label per facet — type, priority, status", () => {
		assert.deepStrictEqual(desiredLabels(TRIAGED), ["type:bug", "p2", "status:triaged"]);
	});

	it("carries the requested stage when it is not the default", () => {
		assert.deepStrictEqual(desiredLabels({...TRIAGED, status: "needs-info"}), [
			"type:bug",
			"p2",
			"status:needs-info",
		]);
	});
});

describe("supersededLabels", () => {
	it("the #3771 defect: a re-prioritize supersedes the old priority", () => {
		assert.deepStrictEqual(
			supersededLabels(["type:decision", "status:triaged", "p2"], {
				type: "decision",
				priority: "p1",
				status: "triaged",
			}),
			["p2"],
		);
	});

	it("a re-type supersedes the old type — the same rule, the same shape", () => {
		assert.deepStrictEqual(
			supersededLabels(["type:bug", "status:triaged", "p2"], {
				type: "chore",
				priority: "p2",
				status: "triaged",
			}),
			["type:bug"],
		);
	});

	it("the queue label is not a special case — it is the status facet's superseded member", () => {
		assert.deepStrictEqual(supersededLabels(["status:needs-triage"], TRIAGED), [
			"status:needs-triage",
		]);
	});

	it("supersedes every facet at once on a full re-triage", () => {
		assert.deepStrictEqual(
			[...supersededLabels(["type:chore", "p0", "status:needs-triage"], TRIAGED)].sort(),
			["p0", "status:needs-triage", "type:chore"],
		);
	});

	it("is idempotent: an entity already in the contract's shape supersedes nothing", () => {
		assert.deepStrictEqual(supersededLabels(["type:bug", "p2", "status:triaged"], TRIAGED), []);
	});

	it("tolerates a facet that is absent entirely — nothing to remove is not a failure", () => {
		assert.deepStrictEqual(supersededLabels([], TRIAGED), []);
		assert.deepStrictEqual(supersededLabels(["type:bug"], TRIAGED), []);
	});

	it("never touches a label outside the three facets — this is not a label reconciler", () => {
		assert.deepStrictEqual(
			supersededLabels(["epic", "good first issue", "pipeline", "p1"], TRIAGED),
			["p1"],
		);
	});

	it("reconciles a priority bucket beyond p0/p1/p2 rather than leaving a second priority", () => {
		assert.deepStrictEqual(supersededLabels(["p10"], TRIAGED), ["p10"]);
	});

	it("does not mistake a `p`-prefixed word for a priority label", () => {
		assert.deepStrictEqual(supersededLabels(["pipeline", "product", "p2"], TRIAGED), []);
	});

	it("de-duplicates a repeated superseded label", () => {
		assert.deepStrictEqual(supersededLabels(["p1", "p1"], TRIAGED), ["p1"]);
	});
});
