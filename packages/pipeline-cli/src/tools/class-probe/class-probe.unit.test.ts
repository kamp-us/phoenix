import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	classify,
	FAILCLOSED_PROBES,
	FAILCLOSED_UI_RE,
	isUiAffecting,
	parseClassProbes,
	parseUiProbe,
	requiredNamespaces,
} from "./class-probe.ts";

// The real, single-sourced §CLASS probes — read off the on-disk contract so these tests
// pin the LIVE classification, not a fixture that could drift from it (#2434). This is the
// same source ship-it Step 0 and the reviewer fan re-resolve from origin/main.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FORMATS_PATH = join(
	REPO_ROOT,
	"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
);
const LIVE_PROBES = parseClassProbes(readFileSync(FORMATS_PATH, "utf8"));
// The additive UI_RE off its live single source (ship-it/SKILL.md) — same discipline.
const SHIP_IT_PATH = join(REPO_ROOT, "claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md");
const LIVE_UI_RE = parseUiProbe(readFileSync(SHIP_IT_PATH, "utf8"));

describe("parseClassProbes", () => {
	it("extracts the four single-quoted §CLASS probes off the live contract", () => {
		expect(LIVE_PROBES.hasCode).toBe("^(apps|packages|\\.glossary|infra)/");
		expect(LIVE_PROBES.hasSkills).toBe("^claude-plugins/[^/]+/(skills|agents)/|^\\.claude-plugin/");
		expect(LIVE_PROBES.docsExclude).toBe("^(claude-plugins|apps|packages|\\.glossary|infra)/");
		expect(LIVE_PROBES.docs).toBe("^(\\.decisions|\\.patterns)/|\\.md$");
	});

	it("takes the single-quoted canonical line, not the double-quoted reresolve_re lines", () => {
		// §CLASS also carries `HAS_CODE_RE="$(reresolve_re ...)"` lines; the parser must not
		// capture those (they'd yield the shell expression, not the regex).
		expect(LIVE_PROBES.hasCode.startsWith("^(")).toBe(true);
	});

	it("falls back to fail-closed defaults for a missing/truncated source", () => {
		expect(parseClassProbes("")).toEqual(FAILCLOSED_PROBES);
	});
});

describe("classify — the PR #2434 miss is pinned closed", () => {
	// The whole reason this tool exists: `.glossary/**` reads like a doc surface, so the
	// LLM reviewer skipped review-code on PR #2430. It is has-code, and this pins it.
	it("classifies a glossary-only PR as has-code (never doc-only)", () => {
		const classes = classify([".glossary/TERMS.md"], LIVE_PROBES);
		expect(classes).toContain("has-code");
		expect(classes).not.toContain("has-docs");
		expect(requiredNamespaces(classes)).toContain("review-code");
	});

	it("fans BOTH has-code and has-skills for the mixed PR #2430 diff", () => {
		const files = [
			".glossary/TERMS.md",
			"claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md",
			"claude-plugins/kampus-pipeline/agents/wayfinder.md",
		];
		const classes = classify(files, LIVE_PROBES);
		expect(classes).toEqual(["has-code", "has-skills"]);
		expect(requiredNamespaces(classes)).toEqual(["review-code", "review-skill"]);
	});

	it("classifies LANGUAGE.md the same as TERMS.md — all of .glossary/** is has-code", () => {
		expect(classify([".glossary/LANGUAGE.md"], LIVE_PROBES)).toEqual(["has-code"]);
	});
});

describe("classify — the other artifact classes still route correctly", () => {
	it("app/package source is has-code", () => {
		expect(classify(["apps/web/worker/router.ts"], LIVE_PROBES)).toEqual(["has-code"]);
		expect(classify(["packages/pipeline-cli/src/bin.ts"], LIVE_PROBES)).toEqual(["has-code"]);
		expect(classify(["infra/depo/alchemy.run.ts"], LIVE_PROBES)).toEqual(["has-code"]);
	});

	it("a plugin skill/agent is has-skills, not has-docs (carve-out wins)", () => {
		expect(
			classify(["claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md"], LIVE_PROBES),
		).toEqual(["has-skills"]);
		expect(classify(["claude-plugins/kampus-pipeline/agents/reviewer.md"], LIVE_PROBES)).toEqual([
			"has-skills",
		]);
	});

	it("an ADR / pattern / root doc is has-docs", () => {
		expect(classify([".decisions/0173-x.md"], LIVE_PROBES)).toEqual(["has-docs"]);
		expect(classify([".patterns/index.md"], LIVE_PROBES)).toEqual(["has-docs"]);
		expect(classify(["DEVELOPMENT.md"], LIVE_PROBES)).toEqual(["has-docs"]);
	});

	it("fans all three classes for a code + doc + skill diff", () => {
		const files = [
			"apps/web/src/App.tsx",
			".decisions/0173-x.md",
			"claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md",
		];
		expect(classify(files, LIVE_PROBES)).toEqual(["has-code", "has-docs", "has-skills"]);
	});

	it("an empty diff spans no class (no gate required)", () => {
		expect(classify([], LIVE_PROBES)).toEqual([]);
		expect(requiredNamespaces(classify([], LIVE_PROBES))).toEqual([]);
	});
});

describe("classify — fail-closed on an unreadable source over-dispatches, never skips", () => {
	it("dispatches every class when the source is empty (fail-closed probes)", () => {
		// A single arbitrary path matches every class under the fail-closed defaults —
		// the worst case is an extra gate run, never a silently-missing namespace.
		const classes = classify(["some/file.txt"], FAILCLOSED_PROBES);
		expect(classes).toEqual(["has-code", "has-docs", "has-skills"]);
	});
});

describe("parseUiProbe — the additive UI_RE off its single source (ship-it/SKILL.md)", () => {
	it("extracts the live single-quoted UI_RE line", () => {
		expect(LIVE_UI_RE).toBe("^apps/web/src/|\\.tsx$|\\.css$");
	});

	it("falls back to the fail-closed UI_RE for a missing/truncated source", () => {
		expect(parseUiProbe("")).toBe(FAILCLOSED_UI_RE);
		expect(FAILCLOSED_UI_RE).toBe(".");
	});
});

describe("isUiAffecting — review-design reaches a marker, never a phantom-empty namespace (#2485/#2483)", () => {
	// The #2483 stall: two NON-VISUAL fate wire-code registries under apps/web/src tripped
	// has-ui via UI_RE's `^apps/web/src/` branch, but the reviewer fan eyeballed them as
	// non-visual and skipped review-design — so ship-it fail-closed on an empty review-design
	// namespace. The probe must class them has-ui DETERMINISTICALLY so the fan dispatches
	// review-design and ship-it's required gate is one the fan actually resolves to a marker.
	const nonVisualSrcTs = ["apps/web/src/fate/wireMessages.ts", "apps/web/src/lib/fateWireCodes.ts"];

	it("classes a non-visual apps/web/src/*.ts diff has-ui (the #2483 files)", () => {
		expect(isUiAffecting(nonVisualSrcTs, LIVE_UI_RE)).toBe(true);
	});

	it("the same diff is also has-code — fan must dispatch BOTH review-code AND review-design", () => {
		const classes = classify(nonVisualSrcTs, LIVE_PROBES);
		expect(classes).toEqual(["has-code"]);
		// The lockstep contract: what ship-it requires (has-code + has-ui) == what the fan
		// dispatches. The additive review-design rides on top of the class namespace(s).
		expect(requiredNamespaces(classes)).toEqual(["review-code"]);
		expect(isUiAffecting(nonVisualSrcTs, LIVE_UI_RE)).toBe(true);
	});

	it("still fires on the visual surfaces (*.tsx, *.css) it already covered", () => {
		expect(isUiAffecting(["apps/web/src/App.tsx"], LIVE_UI_RE)).toBe(true);
		expect(isUiAffecting(["apps/web/src/styles/theme.css"], LIVE_UI_RE)).toBe(true);
	});

	it("does not fire on a non-UI diff — no phantom review-design on a docs/skill-only PR", () => {
		expect(isUiAffecting([".decisions/0173-x.md"], LIVE_UI_RE)).toBe(false);
		expect(
			isUiAffecting(["claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md"], LIVE_UI_RE),
		).toBe(false);
	});

	it("an empty diff is never UI-affecting (no review-design required)", () => {
		expect(isUiAffecting([], LIVE_UI_RE)).toBe(false);
		expect(isUiAffecting([], FAILCLOSED_UI_RE)).toBe(false);
	});

	it("fail-closed: an unreadable UI_RE treats every changed path as UI-affecting", () => {
		// Mirrors ship-it Step 0 / the reviewer's fail-closed `has-ui` — demand the gate, never
		// silently drop it. Empty diff stays empty (nothing to gate).
		expect(isUiAffecting(["packages/pipeline-cli/src/bin.ts"], FAILCLOSED_UI_RE)).toBe(true);
	});
});
