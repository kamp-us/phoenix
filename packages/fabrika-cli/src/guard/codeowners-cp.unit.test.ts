/**
 * The `codeowners-cp` rule — the `codeowners-cp.unit.test.ts` cases from the v1 CLI, plus the
 * live boundary as its own case.
 *
 * The coverage cases are asymmetric on purpose: this guard detects UNDER-protection only, so an
 * over-broad CODEOWNERS row is a pass here by design, and the tests say so rather than leaving a
 * reader to infer it from an absence.
 */
import {describe, expect, it} from "vitest";
import {
	covers,
	cpPaths,
	expandBranch,
	findUncovered,
	parseCodeownersPatterns,
	renderReport,
	splitTopLevelBranches,
} from "./codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

describe("splitTopLevelBranches", () => {
	// The split is on `|^` rather than `|`, which is what keeps an inner `(a|b)` group intact.
	it("cleaves top-level branches without cutting an inner alternation", () => {
		expect(splitTopLevelBranches("^(a|b)/|^c/")).toEqual(["(a|b)/", "c/"]);
	});
});

describe("expandBranch", () => {
	it("cartesian-expands an alternation group into one path each", () => {
		expect(expandBranch("(\\.claude|\\.github)/")).toEqual([
			{path: ".claude/", kind: "dir"},
			{path: ".github/", kind: "dir"},
		]);
	});

	it("reads a $-anchored leaf as an exact file", () => {
		expect(expandBranch("biome\\.jsonc$")).toEqual([{path: "biome.jsonc", kind: "file"}]);
	});

	it("translates a within-segment class to a gitignore glob", () => {
		expect(expandBranch("packages/demo-cli/src/[^/]+$")).toEqual([
			{path: "packages/demo-cli/src/*", kind: "glob"},
		]);
	});

	// A quantified group is not an alternation, so it needs its own translation before the loop.
	it("translates the any-depth prefix to a double-star", () => {
		expect(expandBranch("([^/]+/)*(lefthook|\\.lefthook)[^/]+$")).toEqual([
			{path: "**/lefthook*", kind: "glob"},
			{path: "**/.lefthook*", kind: "glob"},
		]);
	});
});

describe("covers", () => {
	const owned = (pattern: string) => ({pattern, owners: ["@team"]});

	it("covers a path under a directory entry", () => {
		expect(covers(owned(".github/"), {path: ".github/workflows/", kind: "dir"})).toBe(true);
	});

	// The sibling-file gap is why the §CP `hooks` branch needs two literal CODEOWNERS rows.
	it("does not let a directory entry cover its sibling file", () => {
		expect(covers(owned("plugins/hooks/"), {path: "plugins/hooks.json", kind: "file"})).toBe(false);
	});

	it("covers a file by exact match", () => {
		expect(covers(owned("biome.jsonc"), {path: "biome.jsonc", kind: "file"})).toBe(true);
	});

	it("covers a glob by an identical row or an owning ancestor directory", () => {
		const glob = {path: "packages/x/src/*", kind: "glob"} as const;
		expect(covers(owned("packages/x/src/*"), glob)).toBe(true);
		expect(covers(owned("packages/x/"), glob)).toBe(true);
		expect(covers(owned("packages/y/"), glob)).toBe(false);
	});
});

describe("parseCodeownersPatterns", () => {
	it("skips comments, blanks and owner-less lines", () => {
		const patterns = parseCodeownersPatterns(
			"# a comment\n\n/a/ @team\n/b/\n/c/ @team @other # trailing\n",
		);
		expect(patterns).toEqual([
			{pattern: "a/", owners: ["@team"]},
			{pattern: "c/", owners: ["@team", "@other"]},
		]);
	});
});

describe("findUncovered", () => {
	const paths = [
		{path: ".github/", kind: "dir"},
		{path: "biome.jsonc", kind: "file"},
	] as const;

	it("is empty when every path is owned", () => {
		expect(
			findUncovered(paths, parseCodeownersPatterns("/.github/ @team\n/biome.jsonc @team\n")),
		).toEqual([]);
	});

	it("names the path a dropped row leaves unowned", () => {
		expect(findUncovered(paths, parseCodeownersPatterns("/biome.jsonc @team\n"))).toEqual([
			{path: ".github/", kind: "dir"},
		]);
	});

	// Detecting under-protection only is the deliberate asymmetry: a row wider than the boundary
	// over-gates, which costs an approval, where a missing one merges with none at all.
	it("passes an ancestor row that owns more than the boundary asks", () => {
		expect(
			findUncovered(
				[{path: ".github/workflows/", kind: "dir"}],
				parseCodeownersPatterns("/.github/ @team\n"),
			),
		).toEqual([]);
	});

	// A bare `/` normalizes to the empty pattern and covers nothing — CODEOWNERS has no root
	// catch-all here, which is the precondition the whole zero-approval hazard rests on.
	it("does not read a bare / row as a catch-all", () => {
		expect(findUncovered(paths, parseCodeownersPatterns("/ @team\n"))).toEqual([...paths]);
	});
});

describe("the live boundary", () => {
	it("resolves to a non-empty §CP set", () => {
		expect(cpPaths(CONTROL_PLANE_RE).length).toBeGreaterThan(0);
	});

	it("marks .github/ and .claude/ control-plane", () => {
		const paths = cpPaths(CONTROL_PLANE_RE).map((p) => p.path);
		expect(paths).toContain(".github/");
		expect(paths).toContain(".claude/");
	});
});

describe("renderReport", () => {
	it("names the zero-approval consequence, not just the missing row", () => {
		const report = renderReport([{path: ".github/", kind: "dir"}]);
		expect(report).toContain(".github/");
		expect(report).toContain("#955");
		expect(report).toContain("zero required");
	});
});
