/**
 * T0 unit tests for the pure parse core (`.patterns/effect-testing.md`, ADR 0040).
 * No network, no Effect — total functions over plain data, exercised against
 * representative fixtures drawn from `.claude/skills/gh-issue-intake-formats.md`.
 */
import {assert, describe, it} from "@effect/vitest";
import {isEpic, parseDependencies, parseLabels} from "./parse.ts";

describe("parseLabels", () => {
	it("lifts status / type / priority out of the label set", () => {
		const parsed = parseLabels(["type:feature", "status:triaged", "p2"]);
		assert.strictEqual(parsed.status, "triaged");
		assert.strictEqual(parsed.type, "feature");
		assert.strictEqual(parsed.priority, "p2");
	});

	it("yields null for a namespace with no recognized label", () => {
		const parsed = parseLabels(["p0"]);
		assert.strictEqual(parsed.status, null);
		assert.strictEqual(parsed.type, null);
		assert.strictEqual(parsed.priority, "p0");
	});

	it("ignores unknown labels and unknown values in a known namespace", () => {
		const parsed = parseLabels(["status:frozen", "type:saga", "needs-love", "p1"]);
		assert.strictEqual(parsed.status, null);
		assert.strictEqual(parsed.type, null);
		assert.strictEqual(parsed.priority, "p1");
	});

	it("recognizes the epic type", () => {
		assert.strictEqual(parseLabels(["type:epic"]).type, "epic");
		assert.isTrue(isEpic(["type:epic", "p1"]));
		assert.isFalse(isEpic(["type:feature"]));
	});

	it("returns all-null for an empty label set", () => {
		const parsed = parseLabels([]);
		assert.deepStrictEqual(parsed, {status: null, type: null, priority: null});
	});
});

describe("parseDependencies", () => {
	it("returns an empty topology when there is no Dependencies section", () => {
		const topo = parseDependencies("Just a plain body with no phases.");
		assert.deepStrictEqual(topo.phases, []);
		assert.deepStrictEqual(topo.requires, []);
	});

	it("returns an empty topology for null/empty body", () => {
		assert.deepStrictEqual(parseDependencies(null), {phases: [], requires: []});
		assert.deepStrictEqual(parseDependencies(""), {phases: [], requires: []});
	});

	it("parses ordered phases as parallel groups of issue numbers", () => {
		const body = [
			"## Dependencies",
			"",
			"### Phase 1",
			"- #101 — label schema bootstrap",
			"- #102 — formats contract doc",
			"",
			"### Phase 2",
			"- #103 — report skill",
		].join("\n");
		const topo = parseDependencies(body);
		assert.deepStrictEqual(
			topo.phases.map((p) => ({phase: p.phase, issues: [...p.issues]})),
			[
				{phase: 1, issues: [101, 102]},
				{phase: 2, issues: [103]},
			],
		);
	});

	it("parses requires: edges (single and multiple refs)", () => {
		const body = [
			"## Dependencies",
			"",
			"### Phase 1",
			"- #210 — define the wire schema",
			"- #211 — write the migration script",
			"",
			"### Phase 2",
			"- #212 — implement the encoder (requires: #210)",
			"- #105 — plan-epic skill (requires: #102, #104)",
		].join("\n");
		const topo = parseDependencies(body);
		assert.deepStrictEqual(
			topo.requires.map((e) => ({from: e.from, to: e.to})),
			[
				{from: 212, to: 210},
				{from: 105, to: 102},
				{from: 105, to: 104},
			],
		);
	});

	it("reads phase headings tolerantly (case + hash depth)", () => {
		const body = ["## Dependencies", "#### PHASE 3", "- #301 — a task"].join("\n");
		const topo = parseDependencies(body);
		assert.strictEqual(topo.phases.length, 1);
		assert.strictEqual(topo.phases[0]!.phase, 3);
		assert.deepStrictEqual([...topo.phases[0]!.issues], [301]);
	});

	it("ignores bullet lines before the first phase heading", () => {
		const body = ["- #999 — stray ref above any phase", "### Phase 1", "- #1 — real"].join("\n");
		const topo = parseDependencies(body);
		assert.strictEqual(topo.phases.length, 1);
		assert.deepStrictEqual([...topo.phases[0]!.issues], [1]);
	});

	it("treats a cross-epic requires: ref as a normal edge (does not resolve it)", () => {
		const body = ["### Phase 1", "- #50 — CLI verb (requires: #900)"].join("\n");
		const topo = parseDependencies(body);
		assert.deepStrictEqual(
			topo.requires.map((e) => ({from: e.from, to: e.to})),
			[{from: 50, to: 900}],
		);
	});
});
