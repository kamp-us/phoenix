import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {parseGuardAdrRe} from "../guard-content-probe/guard-content-probe.ts";
import {type ClassifyOptions, classify, parseUnifiedDiff} from "./trivial-diff.ts";

// The live CONTROL_PLANE_RE, IMPORTED from its single source (#2761) — never re-literaled
// here, so this fixture cannot drift from the boundary the way the old hand-copy did (the
// #2673 class). The bin re-resolves it from origin/main at run time; the core takes it as a
// string input. The lockstep test at the bottom re-checks the const against the formats-doc.
const LIVE_RE = CONTROL_PLANE_RE;

const FORMATS_ON_DISK = fileURLToPath(
	new URL(
		"../../../../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
		import.meta.url,
	),
);
// The live GUARD_ADR_RE (ADR 0164), parsed from the same single source the shared
// guard-content-probe verb reads — never re-literaled here, so the guard-touching bound cannot
// drift from §CP. The bin re-resolves it from origin/main; the core takes it as a string.
const LIVE_GUARD_RE = parseGuardAdrRe(readFileSync(FORMATS_ON_DISK, "utf8"));

const opts = (over: Partial<ClassifyOptions> = {}): ClassifyOptions => ({
	controlPlaneRe: LIVE_RE,
	lineBudget: 20,
	guardAdrRe: LIVE_GUARD_RE,
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

describe("classify — a guard-touching .decisions/** ADR forces non-trivial (ADR 0164 / #3645)", () => {
	it("an ADR whose added content relaxes a guard → non-trivial (never the trivial doc branch)", () => {
		const c = classify(
			fileDiff(".decisions/0194-x.md", [
				"This decision relaxes the fail-closed enforcement guard.",
			]),
			opts(),
		);
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/guard-touching/);
	});

	it("an ordinary product ADR with no guard vocabulary stays trivial", () => {
		const c = classify(
			fileDiff(".decisions/0200-sozluk-sort.md", [
				"Term pages sort entries by score, newest first.",
			]),
			opts(),
		);
		expect(c.verdict).toBe("trivial");
	});

	it("null guardAdrRe → fail-closed: any .decisions/** ADR is guard-touching → non-trivial", () => {
		const c = classify(fileDiff(".decisions/0001-x.md", ["a tweak"]), opts({guardAdrRe: null}));
		expect(c.verdict).toBe("non-trivial");
		expect(c.reason).toMatch(/guard-touching/);
	});

	it("a pure-deletion ADR change (no added lines) → guard-touching (fail-closed)", () => {
		const del =
			"diff --git a/.decisions/0001-x.md b/.decisions/0001-x.md\n--- a/.decisions/0001-x.md\n+++ b/.decisions/0001-x.md\n@@ -1 +0,0 @@\n-the guard clause is here\n";
		expect(classify(del, opts()).verdict).toBe("non-trivial");
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

// Lockstep: assert the single-source const equals the CONTROL_PLANE_RE= line in the real
// gh-issue-intake-formats.md on disk — the const↔formats-doc drift check, redundant with
// codeowners-cp + validate-gate-path-drift.sh but cheap belt-and-suspenders (#2761/#2343).
describe("the §CP const stays in lockstep with the formats doc on disk", () => {
	it("equals the canonical CONTROL_PLANE_RE extracted from the formats doc", () => {
		const canonical = extractControlPlaneRe(readFileSync(FORMATS_ON_DISK, "utf8"));
		expect(canonical).not.toBeNull();
		expect(LIVE_RE).toBe(canonical);
	});
});
