/**
 * The ocr-port filter spike's pure half: pattern matching, the placement split, the diff filtering,
 * the preview derivation, and the refusal matrix over probes.
 *
 * The refusal rows below are the invariant's contract: a pattern that can reach a guarded path is
 * refused, the spike's own defaults never are. `guard-trees.sync.unit.test.ts` proves the probes
 * still sit in the guards' sources; this file proves what the filter does about them.
 */
import {describe, expect, it} from "vitest";
import {filesInDiff} from "./diff.ts";
import {
	applyPlacement,
	DEFAULT_EXCLUSIONS,
	diffSections,
	effectiveExclusions,
	filterDiff,
	governedExcluded,
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

describe("git-quoted headers reach the filter", () => {
	// `naïve` arrives octal-escaped inside git's C-style quoting (`core.quotePath`, on by default):
	// the header line carries `"a/na\303\257ve file.md"`, not `a/naïve file.md`.
	const quotedSection = [
		'diff --git "a/na\\303\\257ve file.md" "b/na\\303\\257ve file.md"',
		"index 3333333..4444444 100644",
		'--- "a/na\\303\\257ve file.md"',
		'+++ "b/na\\303\\257ve file.md"',
		"@@ -1 +1 @@",
		"-old",
		"+new",
	].join("\n");
	const plainSection = [
		"diff --git a/plain.md b/plain.md",
		"index 1111111..2222222 100644",
		"--- a/plain.md",
		"+++ b/plain.md",
		"@@ -1 +1 @@",
		"-a",
		"+b",
	].join("\n");
	const DECODED = "na\u00efve file.md";

	it("a quoted first section parses whole, its path decoded", () => {
		const sections = diffSections(`${quotedSection}\n${plainSection}\n`);
		expect(sections.map((section) => section.path)).toEqual([DECODED, "plain.md"]);
		expect(sections[0]?.text).toContain("+new");
	});

	it("the section count matches the completeness proof's count", () => {
		const diff = `${plainSection}\n${quotedSection}\n`;
		expect(diffSections(diff).length).toBe(filesInDiff(diff));
	});

	it("filterDiff keeps the quoted section when the plain one is excluded", () => {
		const filtered = filterDiff(`${plainSection}\n${quotedSection}\n`, ["plain.md"], "before");
		expect(filtered).toContain("+new");
		const enumerated = filtered
			.split("\n")
			.filter((line) => line.startsWith("x-fabrika-excluded-path: "));
		expect(enumerated).toEqual(["x-fabrika-excluded-path: plain.md"]);
	});

	it("previewOf excludes a quoted path by its decoded name and enumerates it", () => {
		const preview = previewOf(
			`${plainSection}\n${quotedSection}\n`,
			"after",
			[{pattern: DECODED, source: "caller"}],
			probes,
		);
		expect(preview._tag).toBe("Preview");
		if (preview._tag !== "Preview") return;
		expect(preview.result.excluded).toEqual([DECODED]);
		expect(preview.result.filtered_diff).not.toContain("+new");
		expect(preview.result.filtered_diff).toContain("x-fabrika-excluded-path: na\u00efve file.md");
	});

	it("a mixed header — one side quoted, one bare — parses", () => {
		const mixed = [
			'diff --git a/plain.ts "b/renamed later.md"',
			"index 5555555..6666666 100644",
			"--- a/plain.ts",
			'+++ "b/renamed later.md"',
			"@@ -1 +1 @@",
			"-x",
			"+y",
		].join("\n");
		const sections = diffSections(`${mixed}\n`);
		expect(sections.map((section) => section.path)).toEqual(["renamed later.md"]);
	});
});

describe("a pattern naming a governed tree literally is refused", () => {
	const governedProbes = [
		{guard: "governedRoots", path: "governed/probe.md", source: "test"},
		{guard: "governedRoots", path: ".claude/probe.md", source: "test"},
		{guard: "governedRoots", path: ".fabrika.jsonc", source: "test"},
	];

	it("a wildcard pattern carrying the governed tree as a literal refuses", () => {
		const refusals = refusalFor([{pattern: "governed/*.ts", source: "caller"}], governedProbes);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]?.guard).toBe("governedRoots");
	});

	it("a deeper literal path under a governed root refuses", () => {
		const refusals = refusalFor(
			[{pattern: ".claude/skills/**/*.ts", source: "config"}],
			governedProbes,
		);
		expect(refusals).toHaveLength(1);
	});

	it("a bare governed-tree prefix refuses", () => {
		const refusals = refusalFor([{pattern: "governed", source: "caller"}], governedProbes);
		expect(refusals).toHaveLength(1);
	});

	it("the defaults and a non-governed file path stay allowed", () => {
		expect(refusalFor(DEFAULT_EXCLUSIONS, governedProbes)).toEqual([]);
		expect(
			refusalFor(
				[{pattern: "packages/epic-ledger/package.json", source: "caller"}],
				governedProbes,
			),
		).toEqual([]);
	});

	it("a double-star-led governed tree refuses — the root's name still pins it behind a glob", () => {
		const refusals = refusalFor([{pattern: "**/governed/**", source: "caller"}], governedProbes);
		expect(refusals).toHaveLength(1);
	});

	it("a double-star-led hidden governed root refuses the same way", () => {
		const refusals = refusalFor([{pattern: "**/.claude/**", source: "caller"}], governedProbes);
		expect(refusals).toHaveLength(1);
	});

	it("a double-star-led bare governed tree — no trailing glob — refuses", () => {
		const refusals = refusalFor([{pattern: "**/governed", source: "caller"}], governedProbes);
		expect(refusals).toHaveLength(1);
	});

	it("a wildcard-led suffix glob is not refused — the fence only refuses what a pattern forces", () => {
		expect(refusalFor([{pattern: "**/*.ts", source: "caller"}], governedProbes)).toEqual([]);
	});

	it("the defaults stay allowed against the governed root alone", () => {
		const rootProbe = [{guard: "governedRoots", path: "governed/probe.md", source: "test"}];
		expect(refusalFor(DEFAULT_EXCLUSIONS, rootProbe)).toEqual([]);
	});

	it("a foreign literal prefix does not pin a governed root deeper in the pattern", () => {
		const refusals = refusalFor(
			[
				{pattern: "packages/**/*.test.ts", source: "config"},
				{pattern: "lib/**/governed/*.ts", source: "caller"},
			],
			governedProbes,
		);
		expect(refusals).toEqual([]);
	});
});

describe("the governed runtime backstop", () => {
	// governedRoots probes only: the file-level `probes` fixture carries the fanout guard's .ts
	// probe, against which `**/*.ts` refuses at the probe arm and never reaches the backstop.
	const backstopProbes = [{guard: "governedRoots", path: "governed/probe.md", source: "test"}];
	const governedSection = [
		"diff --git a/governed/real.ts b/governed/real.ts",
		"--- a/governed/real.ts",
		"+++ b/governed/real.ts",
		"@@ -1 +1,2 @@",
		"+export const governed = 1;",
	].join("\n");
	const ungovernedSection = [
		"diff --git a/src/plain.ts b/src/plain.ts",
		"--- a/src/plain.ts",
		"+++ b/src/plain.ts",
		"@@ -1 +1,2 @@",
		"+export const plain = 1;",
	].join("\n");

	it("governedExcluded names each excluded governed path with its first matching pattern", () => {
		expect(
			governedExcluded(
				["governed/real.ts", "src/a.ts"],
				[{pattern: "**/*.ts", source: "caller"}],
				probes,
			),
		).toEqual([{pattern: "**/*.ts", path: "governed/real.ts"}]);
	});

	it("governedExcluded returns nothing when no excluded path sits under a governed root", () => {
		expect(
			governedExcluded(["src/a.ts", "lib/b.ts"], [{pattern: "**/*.ts", source: "caller"}], probes),
		).toEqual([]);
	});

	it("governedExcluded picks the first pattern in set order when two patterns exclude the path", () => {
		const patterns = [
			{pattern: "**/*.ts", source: "caller" as const},
			{pattern: "governed/**", source: "caller" as const},
		];
		expect(governedExcluded(["governed/real.ts"], patterns, probes)).toEqual([
			{pattern: "**/*.ts", path: "governed/real.ts"},
		]);
	});

	it("previewOf refuses when the filter actually excluded a governed path, naming it", () => {
		const preview = previewOf(
			governedSection,
			"before",
			[{pattern: "**/*.ts", source: "caller"}],
			backstopProbes,
		);
		expect(preview._tag).toBe("Refused");
		if (preview._tag !== "Refused") return;
		expect(preview.refusals).toEqual([
			{
				excludedPath: "governed/real.ts",
				guard: "governedRoots",
				pattern: "**/*.ts",
				probe: "governed/real.ts",
			},
		]);
	});

	it("previewOf still previews when the excluded paths are ungoverned", () => {
		const preview = previewOf(
			ungovernedSection,
			"before",
			[{pattern: "**/*.ts", source: "caller"}],
			backstopProbes,
		);
		expect(preview._tag).toBe("Preview");
	});
});
