import {assert, describe, it} from "@effect/vitest";
import type {SweepPlan} from "./orphan-sweep.ts";
import {renderPlan, renderSummary} from "./report.ts";

const plan: SweepPlan = {
	toDelete: [
		{
			resource: {kind: "worker", name: "phoenix-phoenix-it-report-aaaa"},
			reason: "orphan-integration",
			stage: "it-report",
		},
	],
	kept: [
		{resource: {kind: "worker", name: "phoenix-phoenix-prod-bbbb"}, reason: "protected-stage"},
	],
};

describe("renderSummary", () => {
	it("dry-run uses 'would delete' wording", () => {
		assert.match(renderSummary(plan, false), /would delete 1 resource\(s\), keeping 1/);
	});

	it("--execute uses 'DELETING' wording", () => {
		assert.match(renderSummary(plan, true), /DELETING 1 resource\(s\), keeping 1/);
	});
});

describe("renderPlan", () => {
	it("lists each delete with kind, name, reason, stage", () => {
		const out = renderPlan(plan);
		assert.match(
			out,
			/worker phoenix-phoenix-it-report-aaaa \(orphan-integration, stage it-report\)/,
		);
	});

	it("renders a clear note for an empty plan", () => {
		assert.match(renderPlan({toDelete: [], kept: []}), /nothing to delete/);
	});
});
