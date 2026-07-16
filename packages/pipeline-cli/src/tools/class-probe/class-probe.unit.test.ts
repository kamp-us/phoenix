import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	classify,
	FAILCLOSED_PROBES,
	FAILCLOSED_UI_EXCLUDE_RE,
	FAILCLOSED_UI_RE,
	isUiAffecting,
	parseClassProbes,
	parseUiExclude,
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
// The additive UI_RE + its in-src test carve-out off their live single source (ship-it/SKILL.md).
const SHIP_IT_PATH = join(REPO_ROOT, "claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md");
const SHIP_IT_TEXT = readFileSync(SHIP_IT_PATH, "utf8");
const LIVE_UI_RE = parseUiProbe(SHIP_IT_TEXT);
const LIVE_UI_EXCLUDE = parseUiExclude(SHIP_IT_TEXT);

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

describe("classify — the no-class fail-open is closed: root tooling requires a gate (#2765)", () => {
	// The #2765 fail-open: root-level executable build/lint tooling sits outside the four
	// code roots, so it matched HAS_CODE_RE / HAS_SKILLS_RE / HAS_DOCS_RE none-for-none and
	// classed as "no artifact class" → ship-it required ZERO gates → un-reviewed merge. PR
	// #2760 (GritQL biome plugins) shipped safe only by carrying an unrequired review-code
	// PASS. An unclassified changed file now rides has-code (review-code) — a non-empty diff
	// can never require zero gates.
	it("classifies biome.jsonc as has-code (was: no artifact class)", () => {
		const classes = classify(["biome.jsonc"], LIVE_PROBES);
		expect(classes).toEqual(["has-code"]);
		expect(requiredNamespaces(classes)).toEqual(["review-code"]);
	});

	it("classifies a biome-plugins/*.grit lint rule as has-code", () => {
		expect(classify(["biome-plugins/no-console.grit"], LIVE_PROBES)).toEqual(["has-code"]);
	});

	it("gates the PR #2760 shape (biome-plugins/*.grit + biome.jsonc) with review-code", () => {
		const files = ["biome-plugins/no-console.grit", "biome.jsonc"];
		const classes = classify(files, LIVE_PROBES);
		expect(classes).toEqual(["has-code"]);
		// The load-bearing assertion: the required namespace set is NOT empty — a gate runs.
		expect(requiredNamespaces(classes)).toEqual(["review-code"]);
		expect(requiredNamespaces(classes).length).toBeGreaterThan(0);
	});

	it("routes other root build/lint governors the same way (turbo.json, pnpm-workspace.yaml)", () => {
		expect(classify(["turbo.json"], LIVE_PROBES)).toEqual(["has-code"]);
		expect(classify(["pnpm-workspace.yaml"], LIVE_PROBES)).toEqual(["has-code"]);
	});

	it("an unclassified file rides review-code ALONGSIDE a classified sibling's gate", () => {
		// A docs+tooling diff: the .md is has-docs, the un-classed biome.jsonc pulls in has-code
		// (review-code), so the executable tooling is not left gated only by review-doc.
		const classes = classify([".decisions/0173-x.md", "biome.jsonc"], LIVE_PROBES);
		expect(classes).toEqual(["has-code", "has-docs"]);
		expect(requiredNamespaces(classes)).toContain("review-code");
	});

	it("an empty diff is still un-gated — the fail-closed default fires only on a real file", () => {
		expect(classify([], LIVE_PROBES)).toEqual([]);
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

describe("parseUiProbe / parseUiExclude — the additive UI gate off its single source (ship-it/SKILL.md)", () => {
	it("extracts the live single-quoted UI_RE line", () => {
		// #2470: scope is `^apps/web/src/` ONLY. The old `|\.tsx$|\.css$` branches made the require
		// predicate a superset of review-design's own dispatch/off-ramp (`^apps/web/src/`), so a
		// non-web `.tsx`/`.css` was required-but-unroutable — a phantom review-design gate.
		expect(LIVE_UI_RE).toBe("^apps/web/src/");
	});

	it("extracts the live single-quoted UI_EXCLUDE_RE line (#3071 in-src test carve-out)", () => {
		expect(LIVE_UI_EXCLUDE).toBe("\\.(test|spec)\\.tsx?$");
	});

	it("does not cross-capture UI_EXCLUDE_RE as UI_RE (nor vice-versa)", () => {
		// `^UI_RE=` and `^UI_EXCLUDE_RE=` are distinct line prefixes; parsing must keep them apart.
		expect(parseUiProbe("UI_EXCLUDE_RE='\\.(test|spec)\\.tsx?$'\n")).toBe(FAILCLOSED_UI_RE);
		expect(parseUiExclude("UI_RE='^apps/web/src/'\n")).toBe(FAILCLOSED_UI_EXCLUDE_RE);
	});

	it("falls back to the fail-closed defaults for a missing/truncated source", () => {
		expect(parseUiProbe("")).toBe(FAILCLOSED_UI_RE);
		expect(FAILCLOSED_UI_RE).toBe(".");
		expect(parseUiExclude("")).toBe(FAILCLOSED_UI_EXCLUDE_RE);
		expect(FAILCLOSED_UI_EXCLUDE_RE).toBe("$^");
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
		expect(isUiAffecting(nonVisualSrcTs, LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(true);
	});

	it("the same diff is also has-code — fan must dispatch BOTH review-code AND review-design", () => {
		const classes = classify(nonVisualSrcTs, LIVE_PROBES);
		expect(classes).toEqual(["has-code"]);
		// The lockstep contract: what ship-it requires (has-code + has-ui) == what the fan
		// dispatches. The additive review-design rides on top of the class namespace(s).
		expect(requiredNamespaces(classes)).toEqual(["review-code"]);
		expect(isUiAffecting(nonVisualSrcTs, LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(true);
	});

	it("fires on visual surfaces under apps/web/src (*.tsx, *.css) via the prefix", () => {
		expect(isUiAffecting(["apps/web/src/App.tsx"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(true);
		expect(isUiAffecting(["apps/web/src/styles/theme.css"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(
			true,
		);
	});

	it("does not fire on a non-UI diff — no phantom review-design on a docs/skill-only PR", () => {
		expect(isUiAffecting([".decisions/0173-x.md"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
		expect(
			isUiAffecting(
				["claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md"],
				LIVE_UI_RE,
				LIVE_UI_EXCLUDE,
			),
		).toBe(false);
	});

	it("an empty diff is never UI-affecting (no review-design required)", () => {
		expect(isUiAffecting([], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
		expect(isUiAffecting([], FAILCLOSED_UI_RE, FAILCLOSED_UI_EXCLUDE_RE)).toBe(false);
	});

	it("fail-closed: an unreadable UI_RE treats every changed path as UI-affecting", () => {
		// Mirrors ship-it Step 0 / the reviewer's fail-closed `has-ui` — demand the gate, never
		// silently drop it. The fail-closed exclude (`$^`) carves nothing, so the demand stands.
		expect(
			isUiAffecting(
				["packages/pipeline-cli/src/bin.ts"],
				FAILCLOSED_UI_RE,
				FAILCLOSED_UI_EXCLUDE_RE,
			),
		).toBe(true);
	});
});

describe("isUiAffecting — a non-web .tsx/.css mints NO phantom review-design (#2470)", () => {
	// The #2470 deadlock: ship-it's require predicate was `^apps/web/src/|\.tsx$|\.css$` — a
	// SUPERSET of review-design's own dispatch/off-ramp predicate (`^apps/web/src/`). A `.tsx`/`.css`
	// OUTSIDE apps/web/src (a Hono server-JSX file, a `.tsx` test fixture, a non-web `.css`) matched
	// the require + dispatch but off-ramped at review-design Step 0 with no marker → ship-it blocked
	// on a review-design PASS no run could produce. Now the one live UI_RE is `^apps/web/src/`, so a
	// non-web .tsx/.css is neither required nor dispatched — no phantom gate.
	const nonWebUi = [
		"apps/web/worker/features/foo/index.tsx", // Hono server-JSX in the worker, no rendered surface
		"packages/some-pkg/src/fixtures/sample.tsx", // a .tsx test fixture
		"packages/some-pkg/src/styles.css", // a non-web .css
	];

	it("a non-apps/web/src .tsx/.css is NOT has-ui — no required/dispatched review-design", () => {
		for (const f of nonWebUi) {
			expect(isUiAffecting([f], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
		}
		expect(isUiAffecting(nonWebUi, LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
	});

	it("a real apps/web/src UI file STILL is has-ui — the gate holds for rendered surfaces", () => {
		expect(isUiAffecting(["apps/web/src/App.tsx"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(true);
		expect(isUiAffecting(["apps/web/src/styles/theme.css"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(
			true,
		);
		// and the #2485 non-visual apps/web/src/*.ts stays has-ui via the same prefix branch
		expect(isUiAffecting(["apps/web/src/fate/wireMessages.ts"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(
			true,
		);
	});
});

describe("isUiAffecting — a src-colocated *.test.ts[x] / *.spec.* mints NO review-design (#3071)", () => {
	// The #3071 stall: a test file colocated under apps/web/src (the sibling-colocation convention,
	// e.g. next to a component) matched `^apps/web/src/` and minted a REQUIRED review-design gate —
	// but a test fixture renders no surface, so that gate could only ever no-op PASS. It stalled the
	// test-only PRs #3046/#3047 at ship. The carve-out exempts an ALL-test/spec src diff; a real
	// component or a mixed component+test diff STILL gates (the fail-closed direction: exempt only
	// what provably renders nothing).
	const srcTestOnly = [
		"apps/web/src/Foo.test.tsx",
		"apps/web/src/Foo.test.ts",
		"apps/web/src/fate/liveSubscribeBatch.spec.ts",
		"apps/web/src/lib/util.spec.tsx",
	];

	it("(a) a diff of ONLY src-colocated test/spec files is NOT has-ui", () => {
		for (const f of srcTestOnly) {
			expect(isUiAffecting([f], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
		}
		expect(isUiAffecting(srcTestOnly, LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(false);
	});

	it("(b) a real src component (non-test .tsx / .ts / .css) STILL is has-ui — the gate holds", () => {
		expect(isUiAffecting(["apps/web/src/Foo.tsx"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(true);
		expect(isUiAffecting(["apps/web/src/fate/wireMessages.ts"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(
			true,
		);
		expect(isUiAffecting(["apps/web/src/styles/theme.css"], LIVE_UI_RE, LIVE_UI_EXCLUDE)).toBe(
			true,
		);
	});

	it("(c) a MIXED diff (component + its colocated test) STILL is has-ui — the component gates", () => {
		expect(
			isUiAffecting(
				["apps/web/src/Foo.tsx", "apps/web/src/Foo.test.tsx"],
				LIVE_UI_RE,
				LIVE_UI_EXCLUDE,
			),
		).toBe(true);
	});

	it("classes the test-only diff as has-code (review-code) — it is gated, just not review-design", () => {
		// The carve-out removes ONLY the phantom review-design, never the real review-code gate:
		// a src `.test.ts[x]` is still `apps/web/**` → has-code, so the test change is reviewed.
		const classes = classify(srcTestOnly, LIVE_PROBES);
		expect(classes).toEqual(["has-code"]);
		expect(requiredNamespaces(classes)).toEqual(["review-code"]);
	});

	it("fail-closed: an unreadable UI_EXCLUDE_RE carves nothing ⇒ a src test still demands review-design", () => {
		// Safe direction: if the carve-out source can't be read, over-gate rather than silently
		// exempt. `$^` never matches, so the test file falls through to the UI_RE test.
		expect(isUiAffecting(["apps/web/src/Foo.test.tsx"], LIVE_UI_RE, FAILCLOSED_UI_EXCLUDE_RE)).toBe(
			true,
		);
	});
});
