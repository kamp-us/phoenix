/**
 * `pointer-guard`'s extraction and path-likeness filter, ported from the v1 CLI's
 * `pointer-guard.unit.test.ts` (#988) — the precision boundary is what these cases pin.
 */
import {describe, expect, it} from "vitest";
import {extractPathRefs, maskFences, stalePointersIn, staleReport, toPathRef} from "./pointer.ts";

describe("toPathRef", () => {
	it("accepts a repo-root-relative path under a known top-level segment", () => {
		expect(toPathRef("apps/web/worker/index.ts")).toBe("apps/web/worker/index.ts");
		expect(toPathRef("packages/fabrika-cli/src")).toBe("packages/fabrika-cli/src");
		expect(toPathRef(".patterns/index.md")).toBe(".patterns/index.md");
	});

	it("strips a trailing sentence punctuation, a fragment, a query and a line locator", () => {
		expect(toPathRef("apps/web/index.ts.")).toBe("apps/web/index.ts");
		expect(toPathRef("docs/x.md#section")).toBe("docs/x.md");
		expect(toPathRef("docs/x.md?raw")).toBe("docs/x.md");
		expect(toPathRef("apps/web/index.ts:42:7")).toBe("apps/web/index.ts");
	});

	it("normalizes a trailing slash so a directory pointer resolves", () => {
		expect(toPathRef("apps/web/")).toBe("apps/web");
	});

	// The precision lever: an ambiguous token is left alone rather than guessed at.
	it("rejects everything that is not unambiguously a repo path", () => {
		expect(toPathRef("pnpm dev")).toBeNull();
		expect(toPathRef("catalog:")).toBeNull();
		expect(toPathRef("type:bug")).toBeNull();
		expect(toPathRef("https://example.com/a/b")).toBeNull();
		expect(toPathRef("apps/*/worker")).toBeNull();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder is exactly what the filter must reject, so the case has to spell one.
		expect(toPathRef("apps/web/${NAME}.ts")).toBeNull();
		expect(toPathRef("@kampus/web")).toBeNull();
		expect(toPathRef("../apps/web")).toBeNull();
		expect(toPathRef("config.ts")).toBeNull();
		expect(toPathRef("worker/db/resources.ts")).toBeNull();
		expect(toPathRef("")).toBeNull();
	});
});

describe("maskFences", () => {
	it("blanks a fenced block while preserving its line count", () => {
		const text = "a\n```bash\ncd apps/web\n```\nb";
		const masked = maskFences(text);
		expect(masked).not.toContain("apps/web");
		expect(masked.split("\n")).toHaveLength(text.split("\n").length);
	});
});

describe("extractPathRefs", () => {
	it("reads inline spans and reports their 1-based line", () => {
		const refs = extractPathRefs("intro\nsee `apps/web/index.ts` here\n");
		expect(refs).toEqual([{path: "apps/web/index.ts", line: 2}]);
	});

	// Inline spans are what this guard reads; a fenced example is not a live pointer.
	it("ignores a path inside a fenced block", () => {
		expect(extractPathRefs("```\ncp apps/web/.env.example apps/web/.env\n```\n")).toEqual([]);
	});

	it("ignores markdown link syntax, which the other gate owns", () => {
		expect(extractPathRefs("see [the index](.patterns/index.md)")).toEqual([]);
	});
});

describe("stalePointersIn", () => {
	it("keeps only the pointers the predicate rejects", () => {
		const text = "`apps/web/here.ts` and `apps/web/gone.ts`";
		expect(stalePointersIn("CLAUDE.md", text, (p) => p === "apps/web/here.ts")).toEqual([
			{file: "CLAUDE.md", line: 1, path: "apps/web/gone.ts"},
		]);
	});
});

describe("staleReport", () => {
	it("names each pointer by file, line and path", () => {
		const report = staleReport("guard pointer-guard check", [
			{file: "CLAUDE.md", line: 7, path: "apps/web/gone.ts"},
		]);
		expect(report).toContain("CLAUDE.md:7  →  apps/web/gone.ts");
		expect(report).toContain("1 stale CLAUDE.md pointer");
	});
});
