import {assert, describe, it} from "@effect/vitest";
import {countAcceptanceCriteria, parseDependencyGraph} from "./markdown.ts";

describe("countAcceptanceCriteria", () => {
	it("counts checkbox items under an `### Acceptance criteria` heading", () => {
		const body = [
			"### What to build",
			"do the thing",
			"",
			"### Acceptance criteria",
			"- [ ] first",
			"- [x] second already done",
			"- [ ] third",
		].join("\n");
		assert.strictEqual(countAcceptanceCriteria(body), 3);
	});

	it("returns 0 when there is no acceptance-criteria section", () => {
		assert.strictEqual(countAcceptanceCriteria("### What to build\njust prose"), 0);
	});

	it("returns 0 for an empty acceptance-criteria section", () => {
		assert.strictEqual(countAcceptanceCriteria("### Acceptance criteria\n\n### Next section"), 0);
	});

	it("stops counting at the next same-or-higher-level heading", () => {
		const body = ["### Acceptance criteria", "- [ ] counted", "## Other", "- [ ] not counted"].join(
			"\n",
		);
		assert.strictEqual(countAcceptanceCriteria(body), 1);
	});

	it("ignores prose bullets that are not checkboxes", () => {
		const body = ["### Acceptance criteria", "- a plain bullet", "- [ ] a real criterion"].join(
			"\n",
		);
		assert.strictEqual(countAcceptanceCriteria(body), 1);
	});

	it("is tolerant of heading case and `*`/`+` bullet markers", () => {
		const body = ["### acceptance CRITERIA", "* [ ] star", "+ [x] plus"].join("\n");
		assert.strictEqual(countAcceptanceCriteria(body), 2);
	});
});

describe("parseDependencyGraph", () => {
	it("marks the section absent when there is no `## Dependencies`", () => {
		const g = parseDependencyGraph("## Goal\nsome plan");
		assert.strictEqual(g.present, false);
		assert.deepStrictEqual(g.nodes, []);
		assert.deepStrictEqual(g.edges, []);
	});

	it("parses phases into the phase-boundary default edges", () => {
		const body = [
			"## Dependencies",
			"",
			"### Phase 1",
			"- #101 — wire schema",
			"- #102 — migration",
			"",
			"### Phase 2",
			"- #103 — smoke test",
		].join("\n");
		const g = parseDependencyGraph(body);
		assert.strictEqual(g.present, true);
		assert.deepStrictEqual(g.nodes, [101, 102, 103]);
		assert.deepStrictEqual(g.edges, [
			{child: 103, requires: 101},
			{child: 103, requires: 102},
		]);
	});

	it("honors an explicit `requires:` as the precise gate over the phase default", () => {
		const body = [
			"## Dependencies",
			"### Phase 1",
			"- #210 — wire schema",
			"- #211 — migration",
			"### Phase 2",
			"- #212 — encoder (requires: #210)",
		].join("\n");
		const g = parseDependencyGraph(body);
		assert.deepStrictEqual(g.edges, [{child: 212, requires: 210}]);
		assert.deepStrictEqual(g.nodes, [210, 211, 212]);
	});

	it("parses a flat bullet list (no phases) as one parallel group, no edges", () => {
		const body = ["## Dependencies", "- #101 — a", "- #102 — b"].join("\n");
		const g = parseDependencyGraph(body);
		assert.deepStrictEqual(g.nodes, [101, 102]);
		assert.deepStrictEqual(g.edges, []);
	});

	it("reads multiple `requires:` targets on one line", () => {
		const body = [
			"## Dependencies",
			"### Phase 1",
			"- #101",
			"- #102",
			"### Phase 2",
			"- #105 — plan-epic (requires: #101, #102)",
		].join("\n");
		const g = parseDependencyGraph(body);
		assert.deepStrictEqual(g.edges, [
			{child: 105, requires: 101},
			{child: 105, requires: 102},
		]);
	});

	it("includes a `requires:` target that is not a subject anywhere in nodes", () => {
		const body = ["## Dependencies", "### Phase 1", "- #103 — x (requires: #999)"].join("\n");
		const g = parseDependencyGraph(body);
		assert.deepStrictEqual(g.nodes, [103, 999]);
		assert.deepStrictEqual(g.edges, [{child: 103, requires: 999}]);
	});

	it("stops at the next top-level heading after the section", () => {
		const body = [
			"## Dependencies",
			"### Phase 1",
			"- #101",
			"## Notes",
			"- #777 should be ignored",
		].join("\n");
		const g = parseDependencyGraph(body);
		assert.deepStrictEqual(g.nodes, [101]);
	});

	it("is order-independent: declaring the same topology differently yields the same graph", () => {
		const a = parseDependencyGraph(
			["## Dependencies", "### Phase 1", "- #101", "- #102", "### Phase 2", "- #103"].join("\n"),
		);
		const b = parseDependencyGraph(
			["## Dependencies", "### Phase 1", "- #102", "- #101", "### Phase 2", "- #103"].join("\n"),
		);
		assert.deepStrictEqual(a.nodes, b.nodes);
		assert.deepStrictEqual(a.edges, b.edges);
	});
});
