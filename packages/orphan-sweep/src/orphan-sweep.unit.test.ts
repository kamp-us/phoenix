import {assert, describe, it} from "@effect/vitest";
import {
	type CfResource,
	computeSweepPlan,
	type Protection,
	type SweepPlan,
} from "./orphan-sweep.ts";

// Physical names per the deploy.yml-grounded shape: `phoenix-phoenix-<stage>-<suffix>`
// for a worker, `phoenix-phoenix-db-<stage>-<suffix>` for a D1.
const worker = (stage: string, suffix = "1a2b3c4d"): CfResource => ({
	kind: "worker",
	name: `phoenix-phoenix-${stage}-${suffix}`,
});
const d1 = (stage: string, suffix = "1a2b3c4d"): CfResource => ({
	kind: "d1",
	name: `phoenix-phoenix-db-${stage}-${suffix}`,
});

const protection = (over: Partial<Protection> = {}): Protection => ({
	protectedStages: ["prod"],
	openPrNumbers: [],
	sweepClosedPreviews: false,
	...over,
});

const deletedNames = (plan: SweepPlan): ReadonlyArray<string> =>
	plan.toDelete.map((d) => d.resource.name);
const keptReasonFor = (plan: SweepPlan, name: string): string | undefined =>
	plan.kept.find((k) => k.resource.name === name)?.reason;

describe("computeSweepPlan — orphan it-* matching", () => {
	it("deletes an orphan it-* worker and D1", () => {
		const w = worker("it-report-1a2b3c4d");
		const db = d1("it-report-1a2b3c4d");
		const plan = computeSweepPlan([w, db], protection());
		assert.deepStrictEqual(new Set(deletedNames(plan)), new Set([w.name, db.name]));
		assert.strictEqual(plan.toDelete[0]?.reason, "orphan-integration");
		assert.strictEqual(plan.kept.length, 0);
	});

	it("decodes the stage off the physical name for the audit trail", () => {
		// worker("it-pasaport") → phoenix-phoenix-it-pasaport-<suffix>; stage decodes to it-pasaport.
		const plan = computeSweepPlan([worker("it-pasaport")], protection());
		assert.strictEqual(plan.toDelete[0]?.stage, "it-pasaport");
	});

	it("deletes the run-unique it-shared-<disc> stage shape too", () => {
		const plan = computeSweepPlan([d1("it-shared-9z8y7x6w")], protection());
		assert.strictEqual(plan.toDelete.length, 1);
		assert.strictEqual(plan.toDelete[0]?.reason, "orphan-integration");
	});
});

describe("computeSweepPlan — prod is NEVER swept (the catastrophic case)", () => {
	it("keeps the prod worker + D1 as protected-stage", () => {
		const w = worker("prod");
		const db = d1("prod");
		const plan = computeSweepPlan([w, db], protection());
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "protected-stage");
		assert.strictEqual(keptReasonFor(plan, db.name), "protected-stage");
	});

	it("never matches prod via the it- anchor (no false-positive on the prefix)", () => {
		// A pathological stage literally starting `it` but NOT `it-` must not match.
		const plan = computeSweepPlan([worker("italy"), worker("items")], protection());
		assert.strictEqual(plan.toDelete.length, 0);
	});

	it("a stage merely CONTAINING it- as a substring is not an integration stage", () => {
		// `prod-it-x` does not START with `it-`, so it is never swept.
		const plan = computeSweepPlan([worker("prod-it-x")], protection());
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, worker("prod-it-x").name), "unrecognized");
	});
});

describe("computeSweepPlan — named-dev stages are protected", () => {
	it("keeps any stage in protectedStages even if it otherwise looked sweepable", () => {
		// A named-dev stage named `it-umut` would match the it- anchor — protection wins FIRST.
		const w = worker("it-umut");
		const plan = computeSweepPlan([w], protection({protectedStages: ["prod", "it-umut"]}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "protected-stage");
	});
});

describe("computeSweepPlan — open PR previews are protected", () => {
	it("keeps a pr-<n> preview for an OPEN pr", () => {
		const w = worker("pr-712");
		const db = d1("pr-712");
		const plan = computeSweepPlan(
			[w, db],
			protection({openPrNumbers: [712], sweepClosedPreviews: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "open-pr");
		assert.strictEqual(keptReasonFor(plan, db.name), "open-pr");
	});

	it("deletes a CLOSED pr's preview only when sweepClosedPreviews is on", () => {
		const w = worker("pr-99");
		const on = computeSweepPlan([w], protection({sweepClosedPreviews: true}));
		assert.deepStrictEqual(deletedNames(on), [w.name]);
		assert.strictEqual(on.toDelete[0]?.reason, "closed-preview");

		const off = computeSweepPlan([w], protection({sweepClosedPreviews: false}));
		assert.strictEqual(off.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(off, w.name), "preview-sweep-disabled");
	});

	it("an open pr is kept even with preview sweeping ON (open wins over closed-sweep)", () => {
		const w = worker("pr-5");
		const plan = computeSweepPlan([w], protection({openPrNumbers: [5], sweepClosedPreviews: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "open-pr");
	});

	it("pr-<n> anchor rejects pr- with trailing junk and bare pr-", () => {
		const plan = computeSweepPlan(
			[worker("pr-12-foo"), worker("pr-"), worker("pr-abc")],
			protection({sweepClosedPreviews: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
	});
});

describe("computeSweepPlan — foreign / unrecognized resources are never touched", () => {
	it("keeps a non-phoenix resource as unrecognized", () => {
		const foreign: CfResource = {kind: "worker", name: "some-other-app-prod-abcd"};
		const otherDb: CfResource = {kind: "d1", name: "unrelated-db-xyz"};
		const plan = computeSweepPlan([foreign, otherDb], protection());
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, foreign.name), "unrecognized");
		assert.strictEqual(keptReasonFor(plan, otherDb.name), "unrecognized");
	});

	it("a worker named with the D1 prefix is not mis-decoded (kind drives the anchor)", () => {
		// `phoenix-phoenix-db-it-x-...` AS A WORKER decodes stage `db-it-x` (worker prefix
		// has no `db-`), which is NOT an it- stage — so it is kept, never wrongly swept.
		const w: CfResource = {kind: "worker", name: "phoenix-phoenix-db-it-x-1a2b3c4d"};
		const plan = computeSweepPlan([w], protection());
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "unrecognized");
	});

	it("a name with no suffix segment is unrecognized (no stage guess)", () => {
		const w: CfResource = {kind: "worker", name: "phoenix-phoenix-it-report"};
		// `it-report` has internal dashes; the LAST dash splits stage `it` + suffix
		// `report`, which still starts with `it-`? No: stage decodes to `it`, not `it-…`.
		const plan = computeSweepPlan([w], protection());
		// stage `it` does not start with `it-`, so it is kept unrecognized — a malformed
		// name never enters the delete set.
		assert.strictEqual(plan.toDelete.length, 0);
	});
});

describe("computeSweepPlan — edge cases", () => {
	it("an empty resource list yields an empty plan", () => {
		const plan = computeSweepPlan([], protection());
		assert.deepStrictEqual(plan, {toDelete: [], kept: []});
	});

	it("a mixed account: only the orphan it-* are deleted, everything else kept", () => {
		const resources = [
			worker("prod"),
			d1("prod"),
			worker("it-report-aaaa"),
			d1("it-report-aaaa"),
			worker("pr-712"), // open
			worker("pr-99"), // closed, sweeping off
			worker("it-umut"), // protected named-dev
			{kind: "worker" as const, name: "foreign-thing-x"},
		];
		const plan = computeSweepPlan(
			resources,
			protection({protectedStages: ["prod", "it-umut"], openPrNumbers: [712]}),
		);
		assert.deepStrictEqual(
			new Set(deletedNames(plan)),
			new Set([worker("it-report-aaaa").name, d1("it-report-aaaa").name]),
		);
		assert.strictEqual(plan.kept.length, 6);
	});
});
