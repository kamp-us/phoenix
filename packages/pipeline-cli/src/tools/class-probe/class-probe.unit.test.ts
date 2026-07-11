import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {classify, FAILCLOSED_PROBES, parseClassProbes, requiredNamespaces} from "./class-probe.ts";

// The real, single-sourced §CLASS probes — read off the on-disk contract so these tests
// pin the LIVE classification, not a fixture that could drift from it (#2434). This is the
// same source ship-it Step 0 and the reviewer fan re-resolve from origin/main.
const FORMATS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
);
const LIVE_PROBES = parseClassProbes(readFileSync(FORMATS_PATH, "utf8"));

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
