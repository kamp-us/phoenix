import {assert, describe, it} from "@effect/vitest";
import {classify, desiredLabels, supersededLabels} from "./triage-labels.ts";

const TRIAGED = {_tag: "classified", type: "bug", priority: "p2", status: "triaged"} as const;
const PARKED = {_tag: "parked", status: "needs-info"} as const;

describe("classify", () => {
	it("a full judgment on a classified stage is a classification", () => {
		assert.deepStrictEqual(classify({type: "bug", priority: "p2", status: "triaged"}), TRIAGED);
	});

	it("a bare stage judgment on needs-info is the un-classified park", () => {
		assert.deepStrictEqual(classify({status: "needs-info"}), PARKED);
	});

	// The #4042 defect: `--type`/`--p` were unconditionally required, so the ONLY way through the
	// verb was to mint a classification for an issue triage had declined to classify (observed on
	// #4067: type:bug + p2 applied alongside status:needs-info in one write, then hand-corrected).
	it("refuses a needs-info judgment that supplies a type or a priority", () => {
		const withType = classify({type: "bug", status: "needs-info"});
		assert.strictEqual(withType._tag, "invalid");
		assert.include(withType._tag === "invalid" ? withType.reason : "", "no type and no priority");

		assert.strictEqual(classify({priority: "p2", status: "needs-info"})._tag, "invalid");
		assert.strictEqual(
			classify({type: "bug", priority: "p2", status: "needs-info"})._tag,
			"invalid",
		);
	});

	it("a blank facet is an absent one, not a supplied empty label", () => {
		assert.deepStrictEqual(classify({type: "  ", priority: "", status: "needs-info"}), PARKED);
	});

	// The triaged path is unchanged: both facets are still mandatory — the requirement just moved
	// from the flag parser to the stage's own contract, which is what makes it conditional.
	it("refuses a classified stage that omits a facet", () => {
		const missingBoth = classify({status: "triaged"});
		assert.strictEqual(missingBoth._tag, "invalid");
		assert.include(missingBoth._tag === "invalid" ? missingBoth.reason : "", "type and priority");

		assert.strictEqual(classify({type: "bug", status: "triaged"})._tag, "invalid");
		assert.strictEqual(classify({priority: "p2", status: "planned"})._tag, "invalid");
	});
});

describe("desiredLabels", () => {
	it("is exactly one label per facet — type, priority, status", () => {
		assert.deepStrictEqual(desiredLabels(TRIAGED), ["type:bug", "p2", "status:triaged"]);
	});

	it("carries the requested stage when it is not the default", () => {
		assert.deepStrictEqual(desiredLabels({...TRIAGED, status: "planned"}), [
			"type:bug",
			"p2",
			"status:planned",
		]);
	});

	it("the park desires the status alone — no type label, no priority label", () => {
		assert.deepStrictEqual(desiredLabels(PARKED), ["status:needs-info"]);
	});
});

describe("supersededLabels", () => {
	it("the #3771 defect: a re-prioritize supersedes the old priority", () => {
		assert.deepStrictEqual(
			supersededLabels(["type:decision", "status:triaged", "p2"], {
				_tag: "classified",
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
				_tag: "classified",
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

	it("the park drops the queue label, the same one rule", () => {
		assert.deepStrictEqual(supersededLabels(["status:needs-triage"], PARKED), [
			"status:needs-triage",
		]);
	});

	// A facet the classification desires NOTHING from supersedes every member it carries: bouncing
	// an already-typed issue back to needs-info leaves it un-classified, per the skill's "not a
	// type, not a priority" contract — never classified on a stage defined as un-classified.
	it("the park supersedes a pre-existing type AND priority", () => {
		assert.deepStrictEqual(
			[...supersededLabels(["type:bug", "p2", "status:triaged"], PARKED)].sort(),
			["p2", "status:triaged", "type:bug"],
		);
	});

	it("the park still never touches a label outside the three facets", () => {
		assert.deepStrictEqual(
			supersededLabels(["epic", "good first issue", "status:awaiting-release"], PARKED),
			[],
		);
	});

	it("the park is idempotent on an already-parked entity", () => {
		assert.deepStrictEqual(supersededLabels(["status:needs-info"], PARKED), []);
	});

	// The status facet owns the pickability SPINE, not the whole `status:` namespace.
	// `status:awaiting-release` is the release queue's membership marker: superseding it on a
	// re-prioritize would silently drop a dark-shipped issue out of the human release queue.
	it("never supersedes `status:awaiting-release` — it is orthogonal to the pickability spine", () => {
		assert.deepStrictEqual(
			supersededLabels(["type:bug", "status:triaged", "p2", "status:awaiting-release"], {
				_tag: "classified",
				type: "bug",
				priority: "p1",
				status: "triaged",
			}),
			["p2"],
		);
	});

	it("never supersedes the `status:planning` epic-lock — it sits alongside the real status", () => {
		assert.deepStrictEqual(
			supersededLabels(["type:epic", "status:needs-triage", "status:planning"], TRIAGED),
			["type:epic", "status:needs-triage"],
		);
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
