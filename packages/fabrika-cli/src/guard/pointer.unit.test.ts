/**
 * `pointer-guard`'s extraction and path-likeness filter — the precision boundary is what these
 * cases pin.
 */
import {describe, expect, it} from "vitest";
import {extractPathRefs, maskFences, stalePointersIn, staleReport, toPathRef} from "./pointer.ts";

describe("toPathRef", () => {
	it("accepts a repo-root-relative path under a known top-level segment", () => {
		expect(toPathRef("apps/site/worker/index.ts")).toBe("apps/site/worker/index.ts");
		expect(toPathRef("packages/fabrika-cli/src")).toBe("packages/fabrika-cli/src");
		expect(toPathRef(".patterns/index.md")).toBe(".patterns/index.md");
	});

	it("strips a trailing sentence punctuation, a fragment, a query and a line locator", () => {
		expect(toPathRef("apps/site/index.ts.")).toBe("apps/site/index.ts");
		expect(toPathRef("docs/x.md#section")).toBe("docs/x.md");
		expect(toPathRef("docs/x.md?raw")).toBe("docs/x.md");
		expect(toPathRef("apps/site/index.ts:42:7")).toBe("apps/site/index.ts");
	});

	it("normalizes a trailing slash so a directory pointer resolves", () => {
		expect(toPathRef("apps/site/")).toBe("apps/site");
	});

	// The precision lever: an ambiguous token is left alone rather than guessed at.
	it("rejects everything that is not unambiguously a repo path", () => {
		expect(toPathRef("pnpm dev")).toBeNull();
		expect(toPathRef("catalog:")).toBeNull();
		expect(toPathRef("type:bug")).toBeNull();
		expect(toPathRef("https://example.com/a/b")).toBeNull();
		expect(toPathRef("apps/*/worker")).toBeNull();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder is exactly what the filter must reject, so the case has to spell one.
		expect(toPathRef("apps/site/${NAME}.ts")).toBeNull();
		expect(toPathRef("@kampus/web")).toBeNull();
		expect(toPathRef("../apps/site")).toBeNull();
		expect(toPathRef("config.ts")).toBeNull();
		expect(toPathRef("worker/db/resources.ts")).toBeNull();
		expect(toPathRef("")).toBeNull();
	});
});

describe("maskFences", () => {
	it("blanks a fenced block while preserving its line count", () => {
		const text = "a\n```bash\ncd apps/site\n```\nb";
		const masked = maskFences(text);
		expect(masked).not.toContain("apps/site");
		expect(masked.split("\n")).toHaveLength(text.split("\n").length);
	});
});

describe("extractPathRefs", () => {
	it("reads inline spans and reports their 1-based line", () => {
		const refs = extractPathRefs("intro\nsee `apps/site/index.ts` here\n");
		expect(refs).toEqual([{path: "apps/site/index.ts", line: 2}]);
	});

	// Inline spans are what this guard reads; a fenced example is not a live pointer.
	it("ignores a path inside a fenced block", () => {
		expect(extractPathRefs("```\ncp apps/site/.env.example apps/site/.env\n```\n")).toEqual([]);
	});

	it("ignores markdown link syntax, which the other gate owns", () => {
		expect(extractPathRefs("see [the index](.patterns/index.md)")).toEqual([]);
	});
});

describe("stalePointersIn", () => {
	it("keeps only the pointers the predicate rejects", () => {
		const text = "`apps/site/here.ts` and `apps/site/gone.ts`";
		expect(stalePointersIn("CLAUDE.md", text, (p) => p === "apps/site/here.ts")).toEqual([
			{file: "CLAUDE.md", line: 1, path: "apps/site/gone.ts"},
		]);
	});
});

describe("staleReport", () => {
	it("names each pointer by file, line and path", () => {
		const report = staleReport("guard pointer-guard check", [
			{file: "CLAUDE.md", line: 7, path: "apps/site/gone.ts"},
		]);
		expect(report).toContain("CLAUDE.md:7  →  apps/site/gone.ts");
		expect(report).toContain("1 stale CLAUDE.md pointer");
	});
});
