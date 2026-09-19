/**
 * The ocr-port filter spike's pure half: pattern matching, the placement split, the diff filtering,
 * the preview derivation, and the refusal matrix over probes.
 *
 * The refusal rows below are the invariant's contract: a pattern that can reach a guarded path is
 * refused, the spike's own defaults never are. `guard-trees.sync.unit.test.ts` proves the probes
 * still sit in the guards' sources; this file proves what the filter does about them.
 */
import {describe, expect, it} from "vitest";
import {
	applyPlacement,
	DEFAULT_EXCLUSIONS,
	diffSections,
	filterDiff,
	matchPath,
	previewOf,
	refusalFor,
} from "./filter-spike.ts";

const probes = [
	{guard: "catalog-guard", path: "package.json", source: "test"},
	{
		guard: "fanout-guard",
		path: "apps/web/worker/features/fate-live/fanned-mutations.ts",
		source: "test",
	},
	{guard: "governedRoots", path: ".decisions/probe.md", source: "test"},
];

describe("pattern matching", () => {
	it("an exact pattern matches only the exact path", () => {
		expect(matchPath("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
		expect(matchPath("pnpm-lock.yaml", "packages/x/pnpm-lock.yaml")).toBe(false);
	});

	it("a `**/` prefix matches at any depth, including the root", () => {
		expect(matchPath("**/__snapshots__/**", "src/__snapshots__/feature.snap")).toBe(true);
		expect(matchPath("**/__snapshots__/**", "__snapshots__/feature.snap")).toBe(true);
		expect(matchPath("**/__snapshots__/**", "src/feature.snap")).toBe(false);
	});

	it("a trailing `/**` matches everything under the prefix, not beside it", () => {
		expect(matchPath("dist/**", "dist/x.js")).toBe(true);
		expect(matchPath("dist/**", "dist/a/b.js")).toBe(true);
		expect(matchPath("dist/**", "packages/dist/x.js")).toBe(false);
	});

	it("a `*` segment wildcard stops at a slash", () => {
		expect(matchPath("**/*.test.ts", "src/deep/x.test.ts")).toBe(true);
		expect(matchPath("**/*.test.ts", "src/deep/x.ts")).toBe(false);
	});
});

describe("the refusal invariant", () => {
	it("refuses a pattern that reaches a guard probe", () => {
		expect(refusalFor([{pattern: "**/package.json", source: "caller"}], probes)).toEqual([
			{pattern: "**/package.json", guard: "catalog-guard", probe: "package.json"},
		]);
		expect(refusalFor([{pattern: "apps/web/worker/**", source: "caller"}], probes)).toHaveLength(1);
		expect(refusalFor([{pattern: ".decisions/", source: "caller"}], probes)).toHaveLength(1);
	});

	it("never refuses the spike's own defaults over guard probes", () => {
		expect(refusalFor(DEFAULT_EXCLUSIONS, probes)).toEqual([]);
	});
});

describe("the placement split", () => {
	const files = ["src/a.ts", "pnpm-lock.yaml", "src/__snapshots__/a.snap", "src/b.md"];

	it("keeps input order and partitions without overlap", () => {
		const split = applyPlacement(files, DEFAULT_EXCLUSIONS);
		expect(split.kept).toEqual(["src/a.ts", "src/b.md"]);
		expect(split.excluded).toEqual(["pnpm-lock.yaml", "src/__snapshots__/a.snap"]);
	});
});

describe("the diff filter", () => {
	const diff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 1111111..2222222 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1 +1,2 @@",
		"+export const a = 1;",
		"diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
		"index 3333333..4444444 100644",
		"--- a/pnpm-lock.yaml",
		"+++ b/pnpm-lock.yaml",
		"@@ -1 +1,2 @@",
		"+  effect:",
	].join("\n");

	it("splits one section per file, path read off the b-side header", () => {
		expect(diffSections(diff).map((section) => section.path)).toEqual([
			"src/a.ts",
			"pnpm-lock.yaml",
		]);
	});

	it("drops excluded sections whole and names them in a machine-readable header", () => {
		const filtered = filterDiff(diff, ["pnpm-lock.yaml"], "before");
		expect(filtered).toContain("x-fabrika-filter: placement=before excluded=1 served=1");
		expect(filtered).toContain("x-fabrika-excluded-path: pnpm-lock.yaml");
		expect(filtered).toContain("+export const a = 1;");
		expect(filtered).not.toContain("+  effect:");
	});

	it("states excluded=0 when the placement ran and nothing was excluded — not silence", () => {
		const filtered = filterDiff(diff, [], "after");
		expect(filtered).toContain("x-fabrika-filter: placement=after excluded=0 served=2");
	});
});

describe("the preview derivation", () => {
	const diff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1 +1,2 @@",
		"+export const a = 1;",
		"diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
		"--- a/pnpm-lock.yaml",
		"+++ b/pnpm-lock.yaml",
		"@@ -1 +1,2 @@",
		"+  effect:",
	].join("\n");

	it("placement `before`: the lockfile is excluded and the partition derives over kept paths only", () => {
		const preview = previewOf(diff, "before", DEFAULT_EXCLUSIONS, probes);
		expect(preview._tag).toBe("Preview");
		if (preview._tag !== "Preview") return;
		expect(preview.result.matched_paths).toEqual(["src/a.ts"]);
		expect(preview.result.active_classes).toEqual([{name: "code", files: 1}]);
		expect(preview.result.namespaces).toEqual(["review-code"]);
		expect(preview.result.excluded).toEqual(["pnpm-lock.yaml"]);
		expect(preview.result.filtered_diff).toContain("x-fabrika-excluded-path: pnpm-lock.yaml");
	});

	it("placement `after`: the same diff derives over the full read, exclusion enumerated beside it", () => {
		const preview = previewOf(diff, "after", DEFAULT_EXCLUSIONS, probes);
		expect(preview._tag).toBe("Preview");
		if (preview._tag !== "Preview") return;
		expect(preview.result.active_classes).toEqual([{name: "code", files: 2}]);
		expect(preview.result.namespaces).toEqual(["review-code"]);
		expect(preview.result.matched_paths).toEqual(["src/a.ts"]);
	});

	it("placement `before` over an all-excluded diff: zero classes, zero namespaces", () => {
		const lockOnly = [
			"diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -1 +1,2 @@",
			"+  effect:",
		].join("\n");
		const preview = previewOf(lockOnly, "before", DEFAULT_EXCLUSIONS, probes);
		expect(preview._tag).toBe("Preview");
		if (preview._tag !== "Preview") return;
		expect(preview.result.matched_paths).toEqual([]);
		expect(preview.result.active_classes).toEqual([]);
		expect(preview.result.namespaces).toEqual([]);
	});

	it("refuses instead of previewing when a pattern blinds a guard", () => {
		const preview = previewOf(diff, "before", [...DEFAULT_EXCLUSIONS, {pattern: ".decisions/", source: "caller"}], probes);
		expect(preview._tag).toBe("Refused");
	});
});
