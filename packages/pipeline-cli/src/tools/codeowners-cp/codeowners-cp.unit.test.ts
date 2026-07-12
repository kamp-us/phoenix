import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
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

// The live CONTROL_PLANE_RE (gh-issue-intake-formats.md §CP) — kept here only as a
// fixture for the parser; the gate reads it from disk, never from a hardcoded copy.
// The lockstep test at the bottom of this file asserts this fixture still equals the
// canonical §CP line on disk, so it can't silently drift again (#2343).
const LIVE_RE =
	"^(\\.claude|\\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan|triage|write-code|plan-epic)/|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/";

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
			"claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan|triage|write-code|plan-epic)/",
			"claude-plugins/kampus-pipeline/agents/",
			"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$",
			"claude-plugins/kampus-pipeline/hooks(/|\\.json$)",
			"packages/ci-required/",
			"packages/pipeline-cli/",
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

	it("expands the nine skill dirs", () => {
		const out = expandBranch(
			"claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan|triage|write-code|plan-epic)/",
		);
		expect(out.map((p) => p.path)).toEqual([
			"claude-plugins/kampus-pipeline/skills/ship-it/",
			"claude-plugins/kampus-pipeline/skills/review-code/",
			"claude-plugins/kampus-pipeline/skills/review-doc/",
			"claude-plugins/kampus-pipeline/skills/review-skill/",
			"claude-plugins/kampus-pipeline/skills/review-design/",
			"claude-plugins/kampus-pipeline/skills/review-plan/",
			"claude-plugins/kampus-pipeline/skills/triage/",
			"claude-plugins/kampus-pipeline/skills/write-code/",
			"claude-plugins/kampus-pipeline/skills/plan-epic/",
		]);
		expect(out.every((p) => p.kind === "dir")).toBe(true);
	});

	it("passes the group-free agents dir branch through as a single dir (ADR 0150)", () => {
		expect(expandBranch("claude-plugins/kampus-pipeline/agents/")).toEqual([
			{path: "claude-plugins/kampus-pipeline/agents/", kind: "dir"},
		]);
	});

	it("strips the $ end-anchor and unescapes a single exact-file branch", () => {
		expect(
			expandBranch("claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$"),
		).toEqual([
			{path: "claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md", kind: "file"},
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
});

describe("cpPaths over the live regex", () => {
	it("resolves the full §CP path set (17 paths: dirs + the two exact files)", () => {
		expect(cpPaths(LIVE_RE).map((p) => p.path)).toEqual([
			".claude/",
			".github/",
			"claude-plugins/kampus-pipeline/skills/ship-it/",
			"claude-plugins/kampus-pipeline/skills/review-code/",
			"claude-plugins/kampus-pipeline/skills/review-doc/",
			"claude-plugins/kampus-pipeline/skills/review-skill/",
			"claude-plugins/kampus-pipeline/skills/review-design/",
			"claude-plugins/kampus-pipeline/skills/review-plan/",
			"claude-plugins/kampus-pipeline/skills/triage/",
			"claude-plugins/kampus-pipeline/skills/write-code/",
			"claude-plugins/kampus-pipeline/skills/plan-epic/",
			"claude-plugins/kampus-pipeline/agents/",
			"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
			"claude-plugins/kampus-pipeline/hooks/",
			"claude-plugins/kampus-pipeline/hooks.json",
			"packages/ci-required/",
			"packages/pipeline-cli/",
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
});

describe("findUncovered — the drift check", () => {
	const paths = cpPaths(LIVE_RE);

	it("passes (zero uncovered) when CODEOWNERS enumerates every §CP path", () => {
		const codeowners = [
			"/.claude/ @usirin",
			"/.github/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/ship-it/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-code/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-doc/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-skill/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-design/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-plan/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/triage/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/write-code/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/plan-epic/ @usirin",
			"/claude-plugins/kampus-pipeline/agents/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md @usirin",
			"/claude-plugins/kampus-pipeline/hooks/ @usirin",
			"/claude-plugins/kampus-pipeline/hooks.json @usirin",
			"/packages/ci-required/ @usirin",
			"/packages/pipeline-cli/ @usirin",
		].join("\n");
		expect(findUncovered(paths, parseCodeownersPatterns(codeowners))).toEqual([]);
	});

	it("flags a §CP path the regex adds but CODEOWNERS still misses (the drift it guards)", () => {
		// CODEOWNERS missing the hooks rows + pipeline-cli — the exact pre-#955 gap.
		const stale = [
			"/.claude/ @usirin",
			"/.github/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/ship-it/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-code/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-doc/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-skill/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-design/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/review-plan/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/triage/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/write-code/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/plan-epic/ @usirin",
			"/claude-plugins/kampus-pipeline/agents/ @usirin",
			"/claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md @usirin",
			"/packages/ci-required/ @usirin",
		].join("\n");
		const uncovered = findUncovered(paths, parseCodeownersPatterns(stale)).map((p) => p.path);
		expect(uncovered).toEqual([
			"claude-plugins/kampus-pipeline/hooks/",
			"claude-plugins/kampus-pipeline/hooks.json",
			"packages/pipeline-cli/",
		]);
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
// gh-issue-intake-formats.md on disk and assert the LIVE_RE fixture still equals it.
// Without this, the fixture drifts silently from §CP (the review-design/agents/ gap of
// #2343), because validate-gate-path-drift.sh's consumer set never included these unit
// fixtures. This assertion is the drift check the fixtures were missing.
describe("LIVE_RE fixture stays in lockstep with §CP on disk", () => {
	const FORMATS_PATH = fileURLToPath(
		new URL(
			"../../../../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
			import.meta.url,
		),
	);

	it("equals the canonical CONTROL_PLANE_RE extracted from the formats doc", () => {
		const canonical = extractControlPlaneRe(readFileSync(FORMATS_PATH, "utf8"));
		expect(canonical).not.toBeNull();
		expect(LIVE_RE).toBe(canonical);
	});
});
