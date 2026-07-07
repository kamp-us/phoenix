/**
 * The pure `codeql-lint` core — the ReDoS shape detector, the regex extractor, the
 * workflow-permissions parser/judge, and the top-level `judge` (issue #2261).
 * Deterministic transforms over strings / gathered facts, tested with no IO. The
 * filesystem seam (`checkCodeqlLint` over a fake tree) is covered in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type CodeqlLintBaseline,
	detectRedos,
	extractRegexes,
	judge,
	judgeWorkflowPermissions,
	parseWorkflowFacts,
	type WorkflowFacts,
} from "./codeql-lint.ts";

describe("detectRedos — the two catastrophic-backtracking shapes", () => {
	it.each([
		"(a+)+",
		"(a*)*",
		"(a+)*",
		"(a*)+",
		"([a-z]+)+",
		"([a-z0-9]+)*",
		"(\\d+)+",
		"(\\w*)*",
		"(a+){2,}",
		"((ab)+)+",
		"^(x+)+$",
		"(?:a+)+",
		"(?<g>a+)+",
	])("flags nested quantifier %s", (p) => {
		expect(detectRedos(p)).toBe("nested-quantifier");
	});

	it.each([
		"(a+|b)*",
		"(a|a+)+",
		"(\\d+|\\w+)*",
		"(a|a)+",
		"(ab|ab)*",
	])("flags quantified/overlapping alternation %s", (p) => {
		expect(detectRedos(p)).toBe("quantified-alternation");
	});

	it.each([
		"(-[a-z0-9]+)*", // the standard kebab/slug — LINEAR (mandatory `-` separator disambiguates)
		"^[a-z0-9]+(-[a-z0-9]+)*$", // the real repo _stage-name regex — must NOT flag
		"(ab*c)+", // fixed prefix/suffix anchor the iterations
		"(a+b)+", // trailing literal `b` disambiguates
		"(a|b)+", // plain alternation, no overlap
		"(a|b|c)*",
		"(abc)+", // no inner quantifier
		"(a+)", // inner quantifier but the group itself is NOT quantified
		"a+b+c+", // sequential quantifiers, no nesting
		"([a-z]+)", // quantified atom, un-quantified group
		"(a{2,3})+", // bounded inner quantifier
		"(a+){2}", // bounded OUTER quantifier
		"https?://\\S+", // a URL pattern — no dangerous nesting
	])("does not flag the linear/anchored pattern %s", (p) => {
		expect(detectRedos(p)).toBeNull();
	});

	it("does not throw on unbalanced or empty input", () => {
		expect(detectRedos("")).toBeNull();
		expect(detectRedos("(a+")).toBeNull();
		expect(detectRedos("a+)")).toBeNull();
		expect(detectRedos("[(]+")).toBeNull(); // `(` inside a class is a literal
	});
});

describe("extractRegexes — comment/string-aware", () => {
	it("extracts a regex literal and its line", () => {
		const src = "const re = /(a+)+/;\n";
		expect(extractRegexes(src)).toEqual([{line: 1, pattern: "(a+)+"}]);
	});

	it("ignores a regex-looking sequence inside a string or comment", () => {
		const src = ['const s = "/(a+)+/";', "// const c = /(b+)+/;", "/* /(c+)+/ */", ""].join("\n");
		expect(extractRegexes(src)).toEqual([]);
	});

	it("does not misread division as a regex", () => {
		const src = "const x = a / b / c;\n";
		expect(extractRegexes(src)).toEqual([]);
	});

	it("extracts a new RegExp(string) pattern, unescaping the source string", () => {
		const src = 'const re = new RegExp("(a+)+");\n';
		expect(extractRegexes(src)).toContainEqual({line: 1, pattern: "(a+)+"});
	});

	it("keeps a `/` inside a char class from terminating the literal early", () => {
		const src = "const re = /[/]+x/;\n";
		expect(extractRegexes(src)).toEqual([{line: 1, pattern: "[/]+x"}]);
	});
});

describe("workflow permissions", () => {
	const wf = (over: Partial<WorkflowFacts>): WorkflowFacts => ({
		path: ".github/workflows/x.yml",
		hasTopLevelPermissions: false,
		jobs: [],
		...over,
	});

	it("passes a workflow with a top-level permissions block", () => {
		expect(judgeWorkflowPermissions(wf({hasTopLevelPermissions: true}))).toBeNull();
	});

	it("passes a workflow where every job pins its own permissions", () => {
		expect(
			judgeWorkflowPermissions(
				wf({
					jobs: [
						{name: "a", hasPermissions: true},
						{name: "b", hasPermissions: true},
					],
				}),
			),
		).toBeNull();
	});

	it("fails and names the jobs missing a block", () => {
		const f = judgeWorkflowPermissions(
			wf({
				jobs: [
					{name: "a", hasPermissions: true},
					{name: "b", hasPermissions: false},
				],
			}),
		);
		expect(f).not.toBeNull();
		expect(f?.jobsMissing).toEqual(["b"]);
	});

	it("fails with an empty jobsMissing when nothing is pinned anywhere", () => {
		expect(judgeWorkflowPermissions(wf({}))?.jobsMissing).toEqual([]);
	});

	it("parseWorkflowFacts reads top-level + per-job permissions", () => {
		const yaml = [
			"name: x",
			"permissions:",
			"  contents: read",
			"jobs:",
			"  build:",
			"    permissions:",
			"      contents: read",
			"  test:",
			"    runs-on: ubuntu-latest",
		].join("\n");
		const facts = parseWorkflowFacts(".github/workflows/x.yml", yaml);
		expect(facts.hasTopLevelPermissions).toBe(true);
		expect(facts.jobs).toEqual([
			{name: "build", hasPermissions: true},
			{name: "test", hasPermissions: false},
		]);
	});

	it("parseWorkflowFacts fails closed on unparseable YAML", () => {
		const facts = parseWorkflowFacts(".github/workflows/x.yml", "\t: : broken\n  - [");
		expect(facts.hasTopLevelPermissions).toBe(false);
		expect(facts.jobs).toEqual([]);
	});
});

describe("judge — verdict + baseline grandfathering", () => {
	it("fails closed on zero scope", () => {
		expect(judge({workflows: [], regexes: []})).toEqual({pass: false, reason: "zero-scope"});
	});

	it("passes clean facts", () => {
		const v = judge({
			workflows: [{path: "w.yml", hasTopLevelPermissions: true, jobs: []}],
			regexes: [{path: "a.ts", line: 1, pattern: "(a|b)+"}],
		});
		expect(v.pass).toBe(true);
	});

	it("fails on a net-new workflow + a catastrophic regex", () => {
		const v = judge({
			workflows: [{path: "new.yml", hasTopLevelPermissions: false, jobs: []}],
			regexes: [{path: "a.ts", line: 3, pattern: "(x+)+"}],
		});
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "violations") throw new Error("expected violations");
		expect(v.workflowPermissions.map((f) => f.path)).toEqual(["new.yml"]);
		expect(v.redos.map((f) => f.kind)).toEqual(["nested-quantifier"]);
	});

	it("grandfathers a baselined workflow + regex (green despite pre-existing debt)", () => {
		const baseline: CodeqlLintBaseline = {
			grandfatheredWorkflows: ["legacy.yml"],
			grandfatheredRegexes: [{path: "old.ts", pattern: "(x+)+"}],
		};
		const v = judge(
			{
				workflows: [{path: "legacy.yml", hasTopLevelPermissions: false, jobs: []}],
				regexes: [{path: "old.ts", line: 9, pattern: "(x+)+"}],
			},
			baseline,
		);
		expect(v.pass).toBe(true);
	});

	it("still fails a NEW violation while a baselined one is grandfathered", () => {
		const v = judge(
			{
				workflows: [
					{path: "legacy.yml", hasTopLevelPermissions: false, jobs: []},
					{path: "new.yml", hasTopLevelPermissions: false, jobs: []},
				],
				regexes: [],
			},
			{grandfatheredWorkflows: ["legacy.yml"], grandfatheredRegexes: []},
		);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "violations") throw new Error("expected violations");
		expect(v.workflowPermissions.map((f) => f.path)).toEqual(["new.yml"]);
	});
});
