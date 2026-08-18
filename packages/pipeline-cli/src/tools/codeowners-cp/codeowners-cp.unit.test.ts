import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {
	type CpPath,
	covers,
	cpPaths,
	expandBranch,
	extractControlPlaneRe,
	findUncovered,
	parseCodeownersPatterns,
	renderReport,
	splitTopLevelBranches,
} from "./codeowners-cp.ts";

// The live CONTROL_PLANE_RE, IMPORTED from its single source (#2761) — never re-literaled,
// so this fixture cannot drift from the boundary (the #2673 class). The lockstep test at the
// bottom re-checks the const against the CONTROL_PLANE_RE= line on disk.
const LIVE_RE = CONTROL_PLANE_RE;

describe("extractControlPlaneRe", () => {
	it("pulls the regex from the canonical CONTROL_PLANE_RE='…' assignment line", () => {
		const doc = `prose\nCONTROL_PLANE_RE='${LIVE_RE}'\nmore prose`;
		expect(extractControlPlaneRe(doc)).toBe(LIVE_RE);
	});

	it("returns null when no assignment is present (caller fails closed)", () => {
		expect(extractControlPlaneRe("no regex here\njust prose")).toBeNull();
		expect(extractControlPlaneRe("CONTROL_PLANE_RE without quotes")).toBeNull();
	});
});

describe("splitTopLevelBranches", () => {
	it("splits on |^ boundaries, not on inner group alternations", () => {
		const branches = splitTopLevelBranches(LIVE_RE);
		expect(branches).toEqual([
			"(\\.claude|\\.github)/",
			"\\.claude-plugin/",
			"packages/ci-required/",
			"packages/pipeline-cli/src/[^/]+$",
			"packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/",
			"packages/pipeline-cli/src/tools/tracker/gh-io\\.ts$",
			"biome\\.jsonc$",
			"biome-plugins/",
			"([^/]+/)*(lefthook|\\.lefthook)[^/]+$",
		]);
	});
});

describe("expandBranch", () => {
	it("expands a two-way group into two dir prefixes, unescaping \\.", () => {
		expect(expandBranch("(\\.claude|\\.github)/")).toEqual([
			{path: ".claude/", kind: "dir"},
			{path: ".github/", kind: "dir"},
		]);
	});

	it("expands the root marketplace-manifest branch as a dir (ADR 0212)", () => {
		expect(expandBranch("\\.claude-plugin/")).toEqual([{path: ".claude-plugin/", kind: "dir"}]);
	});

	it("expands the whole-tree skills branch to ONE dir prefix (#4458)", () => {
		// The eleven enumerated skill dirs, the `**/*.sh` glob and the formats-doc file collapsed
		// into a single directory — so the ownable CODEOWNERS surface is one row, not thirteen.
		expect(expandBranch("claude-plugins/kampus-pipeline/skills/")).toEqual([
			{path: "claude-plugins/kampus-pipeline/skills/", kind: "dir"},
		]);
	});

	it("passes the group-free agents dir branch through as a single dir (ADR 0150)", () => {
		expect(expandBranch("claude-plugins/kampus-pipeline/agents/")).toEqual([
			{path: "claude-plugins/kampus-pipeline/agents/", kind: "dir"},
		]);
	});

	it("splits the hooks branch into a dir AND a hooks.json file", () => {
		expect(expandBranch("claude-plugins/kampus-pipeline/hooks(/|\\.json$)")).toEqual([
			{path: "claude-plugins/kampus-pipeline/hooks/", kind: "dir"},
			{path: "claude-plugins/kampus-pipeline/hooks.json", kind: "file"},
		]);
	});

	it("passes a group-free dir branch through as a single dir", () => {
		expect(expandBranch("packages/pipeline-cli/")).toEqual([
			{path: "packages/pipeline-cli/", kind: "dir"},
		]);
	});

	it("expands the file-level tracker/gh-io.ts branch to an exact file, not a dir (ADR 0218)", () => {
		expect(expandBranch("packages/pipeline-cli/src/tools/tracker/gh-io\\.ts$")).toEqual([
			{path: "packages/pipeline-cli/src/tools/tracker/gh-io.ts", kind: "file"},
		]);
	});

	it("expands the biome-governance branches: an exact file + a dir prefix (ADR 0193)", () => {
		expect(expandBranch("biome\\.jsonc$")).toEqual([{path: "biome.jsonc", kind: "file"}]);
		expect(expandBranch("biome-plugins/")).toEqual([{path: "biome-plugins/", kind: "dir"}]);
	});

	it("expands the lefthook branch to two any-depth globs (founder ruling on #3402)", () => {
		// Both translations at once: `([^/]+/)*` → `**/` (any depth) and `[^/]+` → `*` (the leaf),
		// so the shape resolves to two ownable CODEOWNERS globs rather than a named path list.
		expect(expandBranch("([^/]+/)*(lefthook|\\.lefthook)[^/]+$")).toEqual([
			{path: "**/lefthook*", kind: "glob"},
			{path: "**/.lefthook*", kind: "glob"},
		]);
	});
});

describe("cpPaths over the live regex", () => {
	it("resolves the full §CP path set (dirs, the exact files, + the biome-governance surfaces)", () => {
		expect(cpPaths(LIVE_RE).map((p) => p.path)).toEqual([
			".claude/",
			".github/",
			".claude-plugin/",
			"packages/ci-required/",
			"packages/pipeline-cli/src/*",
			"packages/pipeline-cli/src/tools/ci-required/",
			"packages/pipeline-cli/src/tools/codeowners-cp/",
			"packages/pipeline-cli/src/tools/control-plane-paths/",
			"packages/pipeline-cli/src/tools/cp-cardinality/",
			"packages/pipeline-cli/src/tools/cp-classify/",
			"packages/pipeline-cli/src/tools/review-head/",
			"packages/pipeline-cli/src/tools/trivial-diff/",
			"packages/pipeline-cli/src/tools/verdict/",
			"packages/pipeline-cli/src/tools/tracker/gh-io.ts",
			"biome.jsonc",
			"biome-plugins/",
			"**/lefthook*",
			"**/.lefthook*",
		]);
	});

	it("resolves zero paths for an empty regex (caller fails closed on zero-scope)", () => {
		expect(cpPaths("")).toEqual([]);
	});
});

describe("parseCodeownersPatterns", () => {
	it("keeps owned lines, strips leading /, drops comments + owner-less lines", () => {
		const text = [
			"# a comment",
			"/.github/   @usirin",
			"",
			"/packages/pipeline-cli/   @usirin   @other",
			"/unowned/", // no owner → not a covering entry
		].join("\n");
		expect(parseCodeownersPatterns(text)).toEqual([
			{pattern: ".github/", owners: ["@usirin"]},
			{pattern: "packages/pipeline-cli/", owners: ["@usirin", "@other"]},
		]);
	});
});

describe("covers", () => {
	const dir = (pattern: string) => ({pattern, owners: ["@usirin"]});
	it("a dir entry covers the dir itself and paths under it", () => {
		expect(covers(dir(".github/"), {path: ".github/", kind: "dir"})).toBe(true);
		expect(
			covers(dir("packages/pipeline-cli/"), {path: "packages/pipeline-cli/", kind: "dir"}),
		).toBe(true);
	});
	it("a dir entry does NOT cover a sibling file (hooks/ ⊉ hooks.json)", () => {
		expect(
			covers(dir("claude-plugins/kampus-pipeline/hooks/"), {
				path: "claude-plugins/kampus-pipeline/hooks.json",
				kind: "file",
			}),
		).toBe(false);
	});
	it("a file entry covers its exact path", () => {
		expect(
			covers(dir("claude-plugins/kampus-pipeline/hooks.json"), {
				path: "claude-plugins/kampus-pipeline/hooks.json",
				kind: "file",
			}),
		).toBe(true);
	});
	it("a bare-name entry covers paths under it (gitignore dir semantics)", () => {
		expect(
			covers(dir("packages/pipeline-cli"), {path: "packages/pipeline-cli/", kind: "dir"}),
		).toBe(true);
	});
	it("a glob §CP path is covered by an identical `*`-glob row, not a mismatched literal", () => {
		const glob: CpPath = {path: "claude-plugins/kampus-pipeline/skills/**/*.sh", kind: "glob"};
		expect(covers(dir("claude-plugins/kampus-pipeline/skills/**/*.sh"), glob)).toBe(true);
		expect(covers(dir("claude-plugins/kampus-pipeline/skills/ship-it/"), glob)).toBe(false);
	});
});

describe("findUncovered — the drift check", () => {
	const paths = cpPaths(LIVE_RE);

	const NARROWED_CODEOWNERS = [
		"/.claude/ @usirin",
		"/.github/ @usirin",
		"/.claude-plugin/ @usirin",
		"/packages/ci-required/ @usirin",
		"/packages/pipeline-cli/src/* @usirin",
		"/packages/pipeline-cli/src/tools/ci-required/ @usirin",
		"/packages/pipeline-cli/src/tools/codeowners-cp/ @usirin",
		"/packages/pipeline-cli/src/tools/control-plane-paths/ @usirin",
		"/packages/pipeline-cli/src/tools/cp-cardinality/ @usirin",
		"/packages/pipeline-cli/src/tools/cp-classify/ @usirin",
		"/packages/pipeline-cli/src/tools/review-head/ @usirin",
		"/packages/pipeline-cli/src/tools/trivial-diff/ @usirin",
		"/packages/pipeline-cli/src/tools/verdict/ @usirin",
		"/packages/pipeline-cli/src/tools/tracker/gh-io.ts @usirin",
		"/biome.jsonc @usirin",
		"/biome-plugins/ @usirin",
		"**/lefthook* @usirin",
		"**/.lefthook* @usirin",
	].join("\n");

	// The ADR-0218 narrowed rows cover every §CP path exactly — in particular the `src/*` glob row
	// covers the `src/[^/]+$` root branch, which is the translation the narrowing relies on.
	it("passes (zero uncovered) under the ADR-0218 narrowed pipeline-cli rows", () => {
		expect(findUncovered(paths, parseCodeownersPatterns(NARROWED_CODEOWNERS))).toEqual([]);
	});

	it("passes (zero uncovered) when CODEOWNERS enumerates every §CP path", () => {
		const codeowners = [
			"/.claude/ @usirin",
			"/.github/ @usirin",
			"/.claude-plugin/ @usirin",
			"/packages/ci-required/ @usirin",
			"/packages/pipeline-cli/ @usirin",
			"/biome.jsonc @usirin",
			"/biome-plugins/ @usirin",
			"**/lefthook* @usirin",
			"**/.lefthook* @usirin",
		].join("\n");
		expect(findUncovered(paths, parseCodeownersPatterns(codeowners))).toEqual([]);
	});

	it("flags a §CP path the regex adds but CODEOWNERS still misses (the drift it guards)", () => {
		// CODEOWNERS missing the pipeline-cli rows — the exact pre-#955 gap.
		const stale = [
			"/.claude/ @usirin",
			"/.github/ @usirin",
			"/.claude-plugin/ @usirin",
			"/packages/ci-required/ @usirin",
			"/biome.jsonc @usirin",
			"/biome-plugins/ @usirin",
		].join("\n");
		const uncovered = findUncovered(paths, parseCodeownersPatterns(stale)).map((p) => p.path);
		expect(uncovered).toEqual([
			"packages/pipeline-cli/src/*",
			"packages/pipeline-cli/src/tools/ci-required/",
			"packages/pipeline-cli/src/tools/codeowners-cp/",
			"packages/pipeline-cli/src/tools/control-plane-paths/",
			"packages/pipeline-cli/src/tools/cp-cardinality/",
			"packages/pipeline-cli/src/tools/cp-classify/",
			"packages/pipeline-cli/src/tools/review-head/",
			"packages/pipeline-cli/src/tools/trivial-diff/",
			"packages/pipeline-cli/src/tools/verdict/",
			"packages/pipeline-cli/src/tools/tracker/gh-io.ts",
			"**/lefthook*",
			"**/.lefthook*",
		]);
	});

	// The file-level branch is the one §CP path a directory row cannot be assumed to carry: the
	// enclosing `tools/tracker/` is deliberately UNOWNED, so gh-io.ts needs its own literal row.
	it("flags tracker/gh-io.ts when its own row is missing (ADR 0218's file-level branch)", () => {
		const withoutGhIo = NARROWED_CODEOWNERS.split("\n")
			.filter((l) => !l.includes("gh-io.ts"))
			.join("\n");
		expect(findUncovered(paths, parseCodeownersPatterns(withoutGhIo)).map((p) => p.path)).toEqual([
			"packages/pipeline-cli/src/tools/tracker/gh-io.ts",
		]);
	});

	// The stale-over-broad direction, stated as a test because it is the one thing this gate does
	// NOT catch (ADR 0218): a CODEOWNERS row broader than the regex leaves paths over-protected,
	// and findUncovered — which only looks for §CP paths with no covering row — reports nothing.
	// The ADR-0218 lockstep narrowing is therefore an author obligation, not a gate-enforced one.
	it("does NOT flag an over-broad CODEOWNERS row (it detects under-protection only)", () => {
		const overBroad = `${NARROWED_CODEOWNERS}\n/packages/pipeline-cli/ @usirin`;
		expect(findUncovered(paths, parseCodeownersPatterns(overBroad))).toEqual([]);
	});
	it("flags a missing /.claude-plugin/ row — the /.claude/ row does NOT cover it (ADR 0212)", () => {
		const owned = parseCodeownersPatterns(["/.claude/ @usirin", "/.github/ @usirin"].join("\n"));
		const marketplace = paths.filter((p) => p.path === ".claude-plugin/");
		expect(marketplace).toHaveLength(1);
		expect(findUncovered(marketplace, owned).map((p) => p.path)).toEqual([".claude-plugin/"]);
	});
});

describe("renderReport", () => {
	it("lists each uncovered path with its kind", () => {
		const out = renderReport([{path: "packages/pipeline-cli/", kind: "dir"} satisfies CpPath]);
		expect(out).toContain("packages/pipeline-cli/  (dir)");
		expect(out).toContain("1 §CP control-plane path");
	});
});

// Lockstep: eat our own dogfood — extract the canonical §CP line from the real
// boundaries.md on disk (the v1 formats doc's successor, #5937) and assert the LIVE_RE
// fixture still equals it. Without this, the fixture drifts silently from §CP (the
// review-design/agents/ gap of #2343). This assertion is the drift check the fixtures
// were missing.
describe("LIVE_RE fixture stays in lockstep with §CP on disk", () => {
	const FORMATS_PATH = fileURLToPath(
		new URL("../control-plane-paths/boundaries.md", import.meta.url),
	);

	it("equals the canonical CONTROL_PLANE_RE extracted from the formats doc", () => {
		const canonical = extractControlPlaneRe(readFileSync(FORMATS_PATH, "utf8"));
		expect(canonical).not.toBeNull();
		expect(LIVE_RE).toBe(canonical);
	});
});
