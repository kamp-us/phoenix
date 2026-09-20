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
	effectiveExclusions,
	filterDiff,
	matchPath,
	previewOf,
	refusalFor,
	unexcludedDefaults,
} from "./filter-spike.ts";

const probes = [
	{guard: "catalog-guard", path: "package.json", source: "test"},
	{
		guard: "fanout-guard",
		path: "src/features/fate-live/fanned-mutations.ts",
		source: "test",
	},
	{guard: "governedRoots", path: "governed/probe.md", source: "test"},
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
		expect(refusalFor([{pattern: "src/features/**", source: "caller"}], probes)).toHaveLength(1);
		expect(refusalFor([{pattern: "governed/", source: "caller"}], probes)).toHaveLength(1);
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

	it("appends the un-excluded defaults, sorted, after the excluded paths", () => {
		const filtered = filterDiff(diff, ["pnpm-lock.yaml"], "before", [
			"**/__mutation__/**",
			"**/__snapshots__/**",
		]);
		const lines = filtered.split("\n").slice(0, 4);
		expect(lines).toEqual([
			"x-fabrika-filter: placement=before excluded=1 served=1",
			"x-fabrika-excluded-path: pnpm-lock.yaml",
			"x-fabrika-unexcluded-path: **/__mutation__/**",
			"x-fabrika-unexcluded-path: **/__snapshots__/**",
		]);
	});

	it("carries no un-excluded lines when the list is empty — byte-identical to the shipped shape", () => {
		const filtered = filterDiff(diff, ["pnpm-lock.yaml"], "before");
		expect(filtered).toBe(filterDiff(diff, ["pnpm-lock.yaml"], "before", []));
		expect(filtered).not.toContain("x-fabrika-unexcluded-path");
	});
});

describe("the effective exclusion set", () => {
	const LOCK = "pnpm-lock.yaml";
	const SNAP = "**/__snapshots__/**";

	it("is the defaults alone when both config arms are empty and no flag is given", () => {
		const effective = effectiveExclusions([], [], null);
		expect(effective.patterns).toEqual(DEFAULT_EXCLUSIONS);
		expect(effective.unexcluded).toEqual([]);
	});

	it("extends the set with config additions, then the CLI's, each source tagged", () => {
		const effective = effectiveExclusions(["dist/**", "coverage/**"], [], "*.gen.ts");
		expect(effective.patterns.map(({pattern}) => pattern)).toEqual([
			"pnpm-lock.yaml",
			SNAP,
			"**/__generated__/**",
			"**/schema.graphql.generated",
			"**/__mutation__/**",
			"dist/**",
			"coverage/**",
			"*.gen.ts",
		]);
		expect(effective.patterns.at(-3)).toMatchObject({source: "config"});
		expect(effective.patterns.at(-1)).toMatchObject({source: "caller"});
		expect(effective.unexcluded).toEqual([]);
	});

	it("removes exactly the named default and enumerates it as un-excluded", () => {
		const effective = effectiveExclusions([], [LOCK], null);
		expect(effective.patterns.map(({pattern}) => pattern)).not.toContain(LOCK);
		expect(effective.unexcluded).toEqual([LOCK]);
	});

	it("drops every named default, in the defaults' own declaration order", () => {
		const effective = effectiveExclusions([], [SNAP, LOCK, "**/__mutation__/**"], null);
		expect(effective.unexcluded).toEqual([LOCK, SNAP, "**/__mutation__/**"]);
		expect(effective.patterns).toHaveLength(2);
	});

	it("lets an equal config addition re-add a removed default — and then it is not un-excluded", () => {
		const effective = effectiveExclusions([LOCK], [LOCK], null);
		expect(effective.patterns).toContainEqual({pattern: LOCK, source: "config"});
		expect(effective.unexcluded).toEqual([]);
	});

	it("lets an equal CLI exclusion re-add a removed default the same way", () => {
		const effective = effectiveExclusions([], [LOCK], LOCK);
		expect(effective.patterns).toContainEqual({pattern: LOCK, source: "caller"});
		expect(effective.unexcluded).toEqual([]);
	});

	it("dedupes by pattern string across every source, first declaration winning", () => {
		const effective = effectiveExclusions([SNAP, "dist/**"], [], `${SNAP}, dist/**`);
		expect(effective.patterns).toHaveLength(DEFAULT_EXCLUSIONS.length + 1);
		expect(effective.patterns.filter(({pattern}) => pattern === SNAP)).toHaveLength(1);
		expect(effective.patterns.filter(({pattern}) => pattern === "dist/**")).toHaveLength(1);
		expect(effective.patterns.find(({pattern}) => pattern === SNAP)?.source).toBe("default");
	});

	it("derives the same un-excluded list the effective set's own absence proves", () => {
		expect(unexcludedDefaults(DEFAULT_EXCLUSIONS)).toEqual([]);
		expect(unexcludedDefaults(effectiveExclusions([], [LOCK], null).patterns)).toEqual([LOCK]);
		expect(unexcludedDefaults(effectiveExclusions([LOCK], [LOCK], null).patterns)).toEqual([]);
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
		const preview = previewOf(
			diff,
			"before",
			[...DEFAULT_EXCLUSIONS, {pattern: "governed/", source: "caller"}],
			probes,
		);
		expect(preview._tag).toBe("Refused");
	});

	it("carries the effective set's un-excluded defaults on the result and into the diff header", () => {
		const effective = effectiveExclusions([], ["pnpm-lock.yaml"], null);
		const preview = previewOf(diff, "after", effective.patterns, probes);
		expect(preview._tag).toBe("Preview");
		if (preview._tag !== "Preview") return;
		expect(preview.result.unexcluded).toEqual(["pnpm-lock.yaml"]);
		// The removal serves the lockfile section — and the header names the removal beside it.
		expect(preview.result.excluded).toEqual([]);
		expect(preview.result.filtered_diff).toContain("x-fabrika-unexcluded-path: pnpm-lock.yaml");
		expect(preview.result.filtered_diff).toContain("+  effect:");
	});
});
