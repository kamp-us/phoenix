import {describe, expect, it} from "vitest";
import {candidateTokens, driftOutcome, isRepoPath} from "./drift.ts";

const TOP_LEVEL = new Set(["packages", "apps", ".patterns", "README.md"]);

describe("candidateTokens", () => {
	it("takes backticked spans and markdown link targets, once each", () => {
		expect(
			candidateTokens("see `packages/a.ts` and [b](apps/b.ts) and `packages/a.ts` again"),
		).toEqual(["packages/a.ts", "apps/b.ts"]);
	});

	// A candidate is ONE whitespace-free token — which is also what keeps a fenced block's contents
	// and an ordinary backticked phrase from arriving here as paths.
	it("drops a span carrying whitespace", () => {
		expect(candidateTokens("`pattern drift` and `a b`")).toEqual([]);
	});
});

describe("isRepoPath", () => {
	it("admits a token whose first segment is a top-level entry of the tree", () => {
		expect(isRepoPath("packages/fabrika-cli/src/bin.ts", TOP_LEVEL)).toBe(true);
		expect(isRepoPath("README.md", TOP_LEVEL)).toBe(true);
	});

	// Precision over recall, at the stated cost of missing a partial pointer: a bare basename and an
	// app-relative fragment are ambiguous shorthand, so they are left alone rather than guessed at.
	it("leaves a bare basename and an app-relative fragment alone", () => {
		expect(isRepoPath("retry.ts", TOP_LEVEL)).toBe(false);
		expect(isRepoPath("worker/queue/retry.ts", TOP_LEVEL)).toBe(false);
	});

	it("drops a glob, a template and a scheme", () => {
		for (const token of ["packages/**/*.test.ts", "packages/{a,b}.ts", "https://example.com"]) {
			expect(isRepoPath(token, TOP_LEVEL)).toBe(false);
		}
	});

	it("keys on the tree's own top level, so a repo with another layout still answers", () => {
		expect(isRepoPath("lib/x.ts", TOP_LEVEL)).toBe(false);
		expect(isRepoPath("lib/x.ts", new Set(["lib"]))).toBe(true);
	});
});

describe("driftOutcome", () => {
	it("is `drifted` when anything moved and `current` when nothing did", () => {
		expect(driftOutcome({inRepo: 3, moved: 1})).toBe("drifted");
		expect(driftOutcome({inRepo: 3, moved: 0})).toBe("current");
	});

	// `unanchored` is NOT a clearance. Reporting it as `current` would be a clean pass over nothing,
	// which is the shape ADR 0092 exists to forbid.
	it("is `unanchored`, never `current`, when nothing was followed", () => {
		expect(driftOutcome({inRepo: 0, moved: 0})).toBe("unanchored");
	});
});
