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

// A Flagship app's physical name shares the alchemy `${stack}-${id}-${stage}-${suffix}`
// shape; id `phoenix_flags` → `phoenix-flags`, so the prefix is `phoenix-phoenix-flags-`.
const flagshipAppName = (stage: string, suffix = "1a2b3c4d"): string =>
	`phoenix-phoenix-flags-${stage}-${suffix}`;
const flagshipApp = (stage: string, suffix = "1a2b3c4d"): CfResource => ({
	kind: "flagship-app",
	name: flagshipAppName(stage, suffix),
	appId: `app-${stage}`,
});
// A flag's KEY is stage-invariant (the same key on every stage's app), so its stage lives
// in the PARENT app's physical name (`appName`), never in `name`.
const flagshipFlag = (
	stage: string,
	key = "phoenix-flags-targeting-demo",
	suffix = "1a2b3c4d",
): CfResource => ({
	kind: "flagship-flag",
	name: key,
	appId: `app-${stage}`,
	appName: flagshipAppName(stage, suffix),
});

const protection = (over: Partial<Protection> = {}): Protection => ({
	protectedStages: ["prod"],
	openPrNumbers: [],
	sweepClosedPreviews: false,
	sweepDevTestStages: false,
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

describe("computeSweepPlan — named-dev (dev-*) stages are a protected category (#2340)", () => {
	// The load-bearing carve-out: dev-usirin-* is named-dev-shaped, so the dev/test opt-in
	// must NEVER reach it. A dev stage belongs to a human; the pure core has no signal
	// (no age, no live-worker match) to tell a dead named-dev stage from an active one, so
	// the whole dev-* family is deny-by-protection.
	it("keeps a dev-usirin stage as named-dev, even with the dev/test sweep ON", () => {
		const w = worker("dev-usirin");
		const db = d1("dev-usirin");
		const plan = computeSweepPlan([w, db], protection({sweepDevTestStages: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "named-dev");
		assert.strictEqual(keptReasonFor(plan, db.name), "named-dev");
	});

	it("keeps any dev-* stage (dev-cansirin) as named-dev with the sweep ON", () => {
		const db = d1("dev-cansirin");
		const plan = computeSweepPlan([db], protection({sweepDevTestStages: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, db.name), "named-dev");
	});

	it("keeps a bare `dev` stage as named-dev (no name segment still means a dev stage)", () => {
		const w = worker("dev");
		const plan = computeSweepPlan([w], protection({sweepDevTestStages: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "named-dev");
	});

	it("never matches `dev` via a substring — `development` is not a dev stage", () => {
		// A stage merely CONTAINING dev is unrecognized, never named-dev, never swept.
		const w = worker("development");
		const plan = computeSweepPlan([w], protection({sweepDevTestStages: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "unrecognized");
	});
});

describe("computeSweepPlan — stale test-* stages sweep only under the opt-in (#2340)", () => {
	// `phoenix-phoenix-db-test-<hash>` decodes to stage `test`; a namespaced test stage to
	// `test-<slug>`. These are machine-owned, run-unique ephemeral stages — like it-* but
	// outside #690's mandate — so they reclaim only behind the explicit opt-in flag.
	it("deletes a bare `test` stage D1 (stale-dev-test) only when the flag is ON", () => {
		const db = d1("test");
		const on = computeSweepPlan([db], protection({sweepDevTestStages: true}));
		assert.deepStrictEqual(deletedNames(on), [db.name]);
		assert.strictEqual(on.toDelete[0]?.reason, "stale-dev-test");
		assert.strictEqual(on.toDelete[0]?.stage, "test");

		const off = computeSweepPlan([db], protection({sweepDevTestStages: false}));
		assert.strictEqual(off.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(off, db.name), "dev-test-sweep-disabled");
	});

	it("deletes a namespaced test-<slug> stage when the flag is ON", () => {
		const w = worker("test-report");
		const on = computeSweepPlan([w], protection({sweepDevTestStages: true}));
		assert.deepStrictEqual(deletedNames(on), [w.name]);
		assert.strictEqual(on.toDelete[0]?.reason, "stale-dev-test");
		assert.strictEqual(on.toDelete[0]?.stage, "test-report");
	});

	it("keeps a test stage that is ALSO explicitly --protect-ed (protection wins first)", () => {
		const w = worker("test-keepme");
		const plan = computeSweepPlan(
			[w],
			protection({protectedStages: ["prod", "test-keepme"], sweepDevTestStages: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "protected-stage");
	});

	it("never matches `test` via a substring — `testing` is not a test stage", () => {
		const w = worker("testing");
		const plan = computeSweepPlan([w], protection({sweepDevTestStages: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, w.name), "unrecognized");
	});

	it("the dev/test opt-in NEVER reaches prod, it-*, or pr-<n> — those keep their own reasons", () => {
		// The new flag widens coverage to test-* ONLY; it must not perturb the existing
		// classifications. it-* still deletes (its own mandate), prod stays protected.
		const resources = [worker("prod"), worker("it-report-aaaa"), worker("pr-5")];
		const plan = computeSweepPlan(
			[...resources],
			protection({openPrNumbers: [5], sweepDevTestStages: true}),
		);
		assert.deepStrictEqual(deletedNames(plan), [worker("it-report-aaaa").name]);
		assert.strictEqual(plan.toDelete[0]?.reason, "orphan-integration");
		assert.strictEqual(keptReasonFor(plan, worker("prod").name), "protected-stage");
		assert.strictEqual(keptReasonFor(plan, worker("pr-5").name), "open-pr");
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

describe("computeSweepPlan — Flagship apps/flags flow through the SAME protection (#1506)", () => {
	it("sweeps a CLOSED pr's flagship app + flag only under the closed-preview gate", () => {
		const app = flagshipApp("pr-99");
		const flag = flagshipFlag("pr-99");
		const on = computeSweepPlan([flag, app], protection({sweepClosedPreviews: true}));
		assert.deepStrictEqual(new Set(deletedNames(on)), new Set([flag.name, app.name]));
		for (const d of on.toDelete) assert.strictEqual(d.reason, "closed-preview");

		const off = computeSweepPlan([flag, app], protection({sweepClosedPreviews: false}));
		assert.strictEqual(off.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(off, app.name), "preview-sweep-disabled");
		assert.strictEqual(keptReasonFor(off, flag.name), "preview-sweep-disabled");
	});

	it("KEEPS an OPEN pr's flagship app + flag even with closed-preview sweeping ON", () => {
		const app = flagshipApp("pr-5");
		const flag = flagshipFlag("pr-5");
		const plan = computeSweepPlan(
			[flag, app],
			protection({openPrNumbers: [5], sweepClosedPreviews: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, app.name), "open-pr");
		assert.strictEqual(keptReasonFor(plan, flag.name), "open-pr");
	});

	it("NEVER sweeps the prod flagship app + flag (protected-stage wins)", () => {
		const app = flagshipApp("prod");
		const flag = flagshipFlag("prod");
		const plan = computeSweepPlan([flag, app], protection({sweepClosedPreviews: true}));
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, app.name), "protected-stage");
		assert.strictEqual(keptReasonFor(plan, flag.name), "protected-stage");
	});

	it("decodes the flag's stage off its PARENT app name, not its stage-invariant key", () => {
		const plan = computeSweepPlan([flagshipFlag("pr-77")], protection({sweepClosedPreviews: true}));
		assert.strictEqual(plan.toDelete[0]?.stage, "pr-77");
	});

	it("sweeps an orphan it-* flagship app + flag as orphan-integration (no gate needed)", () => {
		const app = flagshipApp("it-report-aaaa");
		const flag = flagshipFlag("it-report-aaaa");
		const plan = computeSweepPlan([flag, app], protection());
		assert.deepStrictEqual(new Set(deletedNames(plan)), new Set([flag.name, app.name]));
		for (const d of plan.toDelete) assert.strictEqual(d.reason, "orphan-integration");
	});

	it("keeps a foreign flagship app + flag as unrecognized (prefix not ours)", () => {
		const foreignApp: CfResource = {
			kind: "flagship-app",
			name: "someone-else-flags-prod-abcd",
			appId: "x",
		};
		const foreignFlag: CfResource = {
			kind: "flagship-flag",
			name: "their-key",
			appId: "x",
			appName: "someone-else-flags-pr-1-abcd",
		};
		const plan = computeSweepPlan(
			[foreignApp, foreignFlag],
			protection({sweepClosedPreviews: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, foreignApp.name), "unrecognized");
		assert.strictEqual(keptReasonFor(plan, foreignFlag.name), "unrecognized");
	});

	it("dev/test classification flows through flagship kinds too (#2340)", () => {
		// A leaked test-stage flagship app + flag sweep under the opt-in; a named-dev one never does.
		const testApp = flagshipApp("test");
		const testFlag = flagshipFlag("test");
		const devApp = flagshipApp("dev-usirin");
		const on = computeSweepPlan(
			[testFlag, testApp, devApp],
			protection({sweepDevTestStages: true}),
		);
		assert.deepStrictEqual(new Set(deletedNames(on)), new Set([testFlag.name, testApp.name]));
		for (const d of on.toDelete) assert.strictEqual(d.reason, "stale-dev-test");
		assert.strictEqual(keptReasonFor(on, devApp.name), "named-dev");
	});

	it("a flag named `prod-…` (open pr) is kept even though its KEY looks prod-ish", () => {
		// The flag's key is `phoenix-flags-targeting-demo` (shares the flagship app prefix),
		// but the stage decodes from `appName` = pr-3 — so kind+field choice, not the key, drives it.
		const flag = flagshipFlag("pr-3");
		const plan = computeSweepPlan(
			[flag],
			protection({openPrNumbers: [3], sweepClosedPreviews: true}),
		);
		assert.strictEqual(plan.toDelete.length, 0);
		assert.strictEqual(keptReasonFor(plan, flag.name), "open-pr");
	});
});
