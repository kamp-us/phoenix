/**
 * The gate boundaries compile, are non-trivial, and mean what they meant in prose (issue #4401).
 *
 * The prose lines had no compile step and no test — the only thing standing between a reflow and a
 * changed gate decision was that nobody reflowed the line. Each boundary here gets three checks: it
 * compiles, it clears the non-triviality bound, and it separates a positive from a negative fixture
 * path. The third is the one that catches a "cleaned-up" regex, which the first two would pass.
 *
 * `CLAIM_RE` is pinned to the executable matcher rather than fixture-checked in isolation: the jq
 * form here and the `RegExp` literal in `tools/epic-lock/claim-resolution.ts` are two renderings of
 * one grammar, so the test DERIVES one from the other.
 */
import {describe, expect, it} from "vitest";
import {
	assertNonTrivialBoundary,
	boundaryOrFailClosed,
	CLAIM_RE,
	DOC_VOCAB_EXCLUDE_RE,
	DOC_VOCAB_SURFACE_RE,
	GATE_BOUNDARIES,
	GUARD_ADR_RE,
	HAS_CODE_RE,
	HAS_DOCS_EXCLUDE_RE,
	HAS_DOCS_RE,
	HAS_SKILLS_RE,
	isNonTrivialBoundary,
	MIN_BOUNDARY_LENGTH,
	TrivialGateBoundaryError,
	UI_EXCLUDE_RE,
	UI_RE,
} from "./gate-boundaries.ts";
import {CLAIM_RE as CLAIM_MATCHER} from "./tools/epic-lock/claim-resolution.ts";

/** One positive and one negative path (or, for `GUARD_ADR_RE`, one phrase) per boundary. */
const FIXTURES: ReadonlyArray<readonly [string, string, string, string]> = [
	[
		"GUARD_ADR_RE",
		GUARD_ADR_RE,
		"this ADR relaxes the fail-closed guard",
		"this ADR renames a product noun",
	],
	["HAS_CODE_RE", HAS_CODE_RE, "packages/pipeline-cli/src/run.ts", ".decisions/0218-scope.md"],
	[
		"HAS_SKILLS_RE",
		HAS_SKILLS_RE,
		"claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md",
		"apps/web/src/App.tsx",
	],
	["HAS_DOCS_EXCLUDE_RE", HAS_DOCS_EXCLUDE_RE, ".glossary/LANGUAGE.md", ".decisions/0218-scope.md"],
	["HAS_DOCS_RE", HAS_DOCS_RE, ".patterns/index.md", "apps/web/worker/index.ts"],
	[
		"DOC_VOCAB_EXCLUDE_RE",
		DOC_VOCAB_EXCLUDE_RE,
		"packages/pipeline-cli/README.md",
		".glossary/LANGUAGE.md",
	],
	["DOC_VOCAB_SURFACE_RE", DOC_VOCAB_SURFACE_RE, ".glossary/LANGUAGE.md", "biome.jsonc"],
	[
		"CLAIM_RE",
		// The jq `(?i)` inline flag is not JS syntax; the paired matcher below is what runs.
		CLAIM_RE.replace("(?i)", ""),
		"claim: fcd74bd3-8872-4023-b100-a81ac870eb43 · 2026-07-27T05:13:23Z",
		"claimed by another agent",
	],
	["UI_RE", UI_RE, "apps/web/src/App.tsx", "apps/web/worker/index.ts"],
	["UI_EXCLUDE_RE", UI_EXCLUDE_RE, "apps/web/src/App.test.tsx", "apps/web/src/App.tsx"],
];

describe("the single-sourced gate boundaries (#4401)", () => {
	it("covers every exported boundary with a fixture pair — a new export without one reds this", () => {
		expect(FIXTURES.map(([name]) => name).sort()).toEqual(Object.keys(GATE_BOUNDARIES).sort());
	});

	for (const [name, pattern, positive, negative] of FIXTURES) {
		describe(name, () => {
			it("compiles", () => {
				expect(() => new RegExp(pattern)).not.toThrow();
			});

			it("is non-trivial", () => {
				expect(isNonTrivialBoundary(pattern)).toBe(true);
				expect(pattern.length).toBeGreaterThanOrEqual(MIN_BOUNDARY_LENGTH);
			});

			it("matches its positive fixture and rejects its negative one", () => {
				const re = new RegExp(pattern, "i");
				expect(re.test(positive)).toBe(true);
				expect(re.test(negative)).toBe(false);
			});
		});
	}

	it("renders the same claim grammar as the executable matcher", () => {
		expect(CLAIM_MATCHER.flags).toContain("i");
		expect(`(?i)${CLAIM_MATCHER.source.replace("([0-9a-f-]{36})", "[0-9a-f-]{36}")}`).toBe(
			CLAIM_RE,
		);
	});

	it("keeps the has-code / docs-exclusion roots in lockstep", () => {
		const roots = (re: string): ReadonlyArray<string> =>
			(re.match(/\(([^)]*)\)/)?.[1] ?? "").split("|").filter((r) => r !== "claude-plugins");
		expect(roots(HAS_DOCS_EXCLUDE_RE)).toEqual(roots(HAS_CODE_RE));
	});
});

describe("the non-triviality predicate — the check the prose extraction never had", () => {
	it("rejects the shapes a truncated extraction produces", () => {
		for (const trivial of ["", "   ", ".", "$^", null, undefined]) {
			expect(isNonTrivialBoundary(trivial)).toBe(false);
		}
	});

	it("falls back rather than passing an empty pattern through, unlike `??`", () => {
		expect(boundaryOrFailClosed("", "$^")).toBe("$^");
		expect(boundaryOrFailClosed(undefined, "$^")).toBe("$^");
		expect(boundaryOrFailClosed(HAS_CODE_RE, "$^")).toBe(HAS_CODE_RE);
	});

	it("names the boundary when it throws", () => {
		expect(() => assertNonTrivialBoundary("HAS_DOCS_EXCLUDE_RE", "")).toThrow(
			TrivialGateBoundaryError,
		);
		expect(() => assertNonTrivialBoundary("HAS_DOCS_EXCLUDE_RE", "")).toThrow(
			/HAS_DOCS_EXCLUDE_RE/,
		);
		expect(assertNonTrivialBoundary("HAS_CODE_RE", HAS_CODE_RE)).toBe(HAS_CODE_RE);
	});
});
