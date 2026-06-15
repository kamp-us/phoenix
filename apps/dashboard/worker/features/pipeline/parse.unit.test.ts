/**
 * T0 unit tests for the pure parse core (`.patterns/effect-testing.md`, ADR 0040).
 * No network, no Effect — total functions over plain data, exercised against
 * representative fixtures drawn from `.claude/skills/gh-issue-intake-formats.md`.
 */
import {assert, describe, it} from "@effect/vitest";
import {isEpic, parseDependencies, parseLabels, parseLinkedIssue, parseVerdict} from "./parse.ts";

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

describe("parseLinkedIssue", () => {
	it("reads Fixes #N from a PR body", () => {
		assert.strictEqual(parseLinkedIssue("Surface verdicts.\n\nFixes #257"), 257);
	});

	it("reads Closes / Resolves (and tense variants) case-insensitively", () => {
		assert.strictEqual(parseLinkedIssue("closes #12"), 12);
		assert.strictEqual(parseLinkedIssue("Resolved #9"), 9);
		assert.strictEqual(parseLinkedIssue("FIXED #3"), 3);
	});

	it("returns null for a body with no closing link", () => {
		assert.strictEqual(parseLinkedIssue("Just a refactor, see #5 for context."), null);
		assert.strictEqual(parseLinkedIssue(null), null);
		assert.strictEqual(parseLinkedIssue(""), null);
	});
});

describe("parseVerdict", () => {
	const at = (s: string) => ({createdAt: `2026-06-14T${s}Z`});

	it("returns null verdicts when there are no comments at all", () => {
		assert.deepStrictEqual(parseVerdict([]), {code: null, doc: null});
	});

	it("returns null verdicts when no comment carries a marker (awaiting review)", () => {
		const v = parseVerdict([
			{body: "Thanks, looks good!", ...at("10:00:00")},
			{body: "Bumping CI.", ...at("10:05:00")},
		]);
		assert.deepStrictEqual(v, {code: null, doc: null});
	});

	it("reads a review-code PASS marker (canonical bare first line)", () => {
		const v = parseVerdict([
			{body: "review-code: PASS — merge-ready\n\n| AC | … |", ...at("10:00:00")},
		]);
		assert.strictEqual(v.code, "PASS");
		assert.strictEqual(v.doc, null);
	});

	it("reads a review-code FAIL marker", () => {
		const v = parseVerdict([
			{body: "review-code: FAIL — not merge-ready\n\nAC 2 unmet.", ...at("10:00:00")},
		]);
		assert.strictEqual(v.code, "FAIL");
	});

	it("tolerates leading ** emphasis on the marker (bolded review-code)", () => {
		const v = parseVerdict([{body: "**review-code: PASS — merge-ready**", ...at("10:00:00")}]);
		assert.strictEqual(v.code, "PASS");
	});

	it("is case-insensitive on the namespace and verdict tokens", () => {
		const v = parseVerdict([{body: "Review-Code: pass — merge-ready", ...at("10:00:00")}]);
		assert.strictEqual(v.code, "PASS");
	});

	it("reads the review-doc namespace independently of review-code", () => {
		const v = parseVerdict([{body: "review-doc: FAIL — changes-requested", ...at("10:00:00")}]);
		assert.strictEqual(v.doc, "FAIL");
		assert.strictEqual(v.code, null);
	});

	it("resolves latest-wins per namespace by timestamp", () => {
		const v = parseVerdict([
			{body: "review-code: FAIL — not merge-ready", ...at("10:00:00")},
			{body: "review-code: PASS — merge-ready", ...at("11:00:00")},
		]);
		assert.strictEqual(v.code, "PASS");
	});

	it("resolves latest-wins regardless of comment order in the array", () => {
		const v = parseVerdict([
			{body: "review-code: PASS — merge-ready", ...at("11:00:00")},
			{body: "review-code: FAIL — not merge-ready", ...at("10:00:00")},
		]);
		assert.strictEqual(v.code, "PASS");
	});

	it("resolves code and doc namespaces separately in a mixed thread", () => {
		const v = parseVerdict([
			{body: "review-code: PASS — merge-ready", ...at("10:00:00")},
			{body: "review-doc: FAIL — changes-requested", ...at("10:01:00")},
		]);
		assert.deepStrictEqual(v, {code: "PASS", doc: "FAIL"});
	});

	it("does not match a marker quoted mid-body (must lead the comment)", () => {
		const v = parseVerdict([
			{
				body: "Earlier the bot said\n> review-code: PASS — merge-ready\nbut that was stale.",
				...at("10:00:00"),
			},
		]);
		assert.deepStrictEqual(v, {code: null, doc: null});
	});

	it("ignores a review-doc advisory line (blocking-set PR — not a PASS/FAIL verdict)", () => {
		const v = parseVerdict([
			{body: "review-doc: advisory — blocking-set PR (manual merge)", ...at("10:00:00")},
		]);
		assert.deepStrictEqual(v, {code: null, doc: null});
	});
});
