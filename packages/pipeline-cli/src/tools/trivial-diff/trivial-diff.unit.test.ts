import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {type ClassifyOptions, classify, parseUnifiedDiff} from "./trivial-diff.ts";

// The live CONTROL_PLANE_RE (gh-issue-intake-formats.md §CP) — a fixture only. The bin
// re-resolves this from origin/main at run time; the core takes it as a string input.
// The lockstep test at the bottom of this file asserts this fixture still equals the
// canonical §CP line on disk, so it can't silently drift again (#2343).
const LIVE_RE =
	"^(\\.claude|\\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan)/|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/";

const opts = (over: Partial<ClassifyOptions> = {}): ClassifyOptions => ({
	controlPlaneRe: LIVE_RE,
	lineBudget: 20,
	...over,
});

/** Build a single-file unified-diff block from added/removed line bodies. */
const fileDiff = (path: string, added: string[], removed: string[] = []): string => {
	const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@`;
	const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
	return `${head}\n${body}\n`;
};

describe("parseUnifiedDiff", () => {
	it("returns null when there is no `diff --git` header (unparseable → caller fails closed)", () => {
		expect(parseUnifiedDiff("just some prose, no diff")).toBeNull();
		expect(parseUnifiedDiff("")).toBeNull();
	});

	it("parses paths, counts, and added-line bodies; ignores the +++/--- headers", () => {
		const files = parseUnifiedDiff(fileDiff("src/a.ts", ["return 2;"], ["return 1;"]));
		expect(files).not.toBeNull();
		expect(files).toHaveLength(1);
		expect(files?.[0]).toMatchObject({path: "src/a.ts", additions: 1, deletions: 1});
		expect(files?.[0]?.addedLines).toEqual(["return 2;"]);
	});

	it("takes the post-image (b/) path; falls back to a/ for a deletion to /dev/null", () => {
		const del =
			"diff --git a/old.ts b/dev/null\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
		expect(parseUnifiedDiff(del)?.[0]?.path).toBe("old.ts");
	});
});

describe("classify — trivial cases (all bounds clear)", () => {
	it("doc-only single file → trivial (independent of size)", () => {
		const big = Array.from({length: 80}, (_, i) => `line ${i}`);
		const c = classify(fileDiff("README.md", big), opts());
		expect(c.verdict).toBe("trivial");
		expect(c.reason).toMatch(/doc/);
	});

	it("doc file under a docs dir (.decisions) → trivial", () => {
		expect(classify(fileDiff(".decisions/0001-x.md", ["a tweak"]), opts()).verdict).toBe("trivial");
	});

	it("single small code file under N, no new module edge → trivial", () => {
		const c = classify(
			fileDiff("apps/web/src/x.ts", ['return "hello";'], ['return "helo";']),
			opts(),
		);
		expect(c.verdict).toBe("trivial");
		expect(c.reason).toMatch(/≤ N=20/);
	});
});

describe("classify — non-trivial cases (any bound fails → default-deny)", () => {
	it("multi-file diff → non-trivial", () => {
		const two = fileDiff("apps/web/src/a.ts", ["x"]) + fileDiff("apps/web/src/b.ts", ["y"]);
		const c = classify(two, opts());
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/multi-file/);
	});

	it("new dependency (package.json) → non-trivial (surface path)", () => {
		const c = classify(fileDiff("apps/web/package.json", ['    "left-pad": "1.0.0",']), opts());
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/surface-bearing/);
	});

	it("migration (.sql / migrations dir) → non-trivial (surface path)", () => {
		expect(
			classify(fileDiff("apps/web/migrations/0003_add.sql", ["ALTER TABLE x;"]), opts()).verdict,
		).toBe("non-trivial");
		expect(
			classify(fileDiff("apps/web/drizzle/0003_add.ts", ["export const up = 1;"]), opts()).verdict,
		).toBe("non-trivial");
	});

	it("new surface (added export) in a small single code file → non-trivial (module edge)", () => {
		const c = classify(fileDiff("apps/web/src/api.ts", ["export const route = handler;"]), opts());
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/module edge/);
	});

	it("new import edge → non-trivial", () => {
		expect(
			classify(fileDiff("apps/web/src/x.ts", ['import {z} from "zod";']), opts()).verdict,
		).toBe("non-trivial");
	});

	it("single code file over the line bound N → non-trivial", () => {
		const big = Array.from({length: 25}, (_, i) => `  step${i}();`);
		const c = classify(fileDiff("apps/web/src/big.ts", big), opts());
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/> N=20/);
	});
});

describe("classify — §CP forces non-trivial (live boundary, checked first)", () => {
	it("a control-plane path (packages/pipeline-cli) → non-trivial even if otherwise small", () => {
		const c = classify(fileDiff("packages/pipeline-cli/src/x.ts", ["const n = 2;"]), opts());
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/control-plane/);
	});

	it("a .github path → non-trivial", () => {
		expect(classify(fileDiff(".github/workflows/ci.yml", ["  run: echo hi"]), opts()).verdict).toBe(
			"non-trivial",
		);
	});

	it("a pipeline agent-definition path (claude-plugins/…/agents/) → non-trivial (ADR 0150)", () => {
		const c = classify(
			fileDiff("claude-plugins/kampus-pipeline/agents/coder.md", ["a tweak"]),
			opts(),
		);
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/control-plane/);
	});

	it("the gate-critical formats doc → non-trivial (control-plane checked before doc bound)", () => {
		const c = classify(
			fileDiff("claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md", ["a tweak"]),
			opts(),
		);
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/control-plane/);
	});
});

describe("classify — unreadable / unparseable boundary forces non-trivial (fail-closed)", () => {
	it("null boundary → non-trivial", () => {
		const c = classify(fileDiff("README.md", ["x"]), opts({controlPlaneRe: null}));
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/unreadable/);
	});

	it("empty/whitespace boundary → non-trivial", () => {
		expect(classify(fileDiff("README.md", ["x"]), opts({controlPlaneRe: "   "})).verdict).toBe(
			"non-trivial",
		);
	});

	it("uncompilable boundary regex → non-trivial", () => {
		const c = classify(fileDiff("README.md", ["x"]), opts({controlPlaneRe: "("}));
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/compile/);
	});
});

describe("classify — unparseable / empty diff forces non-trivial (fail-closed)", () => {
	it("non-diff input → non-trivial", () => {
		expect(classify("not a diff at all", opts()).verdict).toBe("non-trivial");
	});
});

// Lockstep: extract the canonical §CP line from the real gh-issue-intake-formats.md on
// disk (via the single-sourced extractControlPlaneRe) and assert LIVE_RE still equals it,
// so this fixture can't silently drift from §CP again (#2343).
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
