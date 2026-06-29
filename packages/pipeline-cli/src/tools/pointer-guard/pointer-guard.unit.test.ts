/**
 * Pure-core tests for `pointer-guard` (#988): the path-likeness filter (`toPathRef`),
 * the inline-span extraction (`extractPathRefs`, with fences masked), and the
 * stale-pointer derivation over an injected `exists` predicate. No disk — the gate's
 * IO is covered in `gate.test.ts`.
 *
 * The precision cases are the load-bearing ones: every token a CLAUDE.md uses that is
 * NOT a repo path (`catalog:`, `type:bug`, `pnpm dev`, a glob, an npm scope, a code
 * snippet) must be rejected, or the gate cries wolf (AC #3).
 */
import {describe, expect, it} from "@effect/vitest";
import {extractPathRefs, findStalePointersIn, toPathRef} from "./pointer-guard.ts";

describe("toPathRef — accepts unambiguous repo-root-relative paths", () => {
	it("accepts a known-prefix path with an extension", () => {
		expect(toPathRef("apps/web/worker/dom/settings.ts")).toBe("apps/web/worker/dom/settings.ts");
		expect(toPathRef("packages/pipeline-cli/src/bin.ts")).toBe("packages/pipeline-cli/src/bin.ts");
		expect(toPathRef(".patterns/index.md")).toBe(".patterns/index.md");
	});

	it("accepts a known-prefix directory pointer (trailing slash normalized)", () => {
		expect(toPathRef("apps/web/worker/")).toBe("apps/web/worker");
		expect(toPathRef("packages/")).toBe("packages");
	});

	it("strips trailing prose punctuation, a #fragment, a ?query, and a :line:col suffix", () => {
		expect(toPathRef("apps/web/worker/index.ts.")).toBe("apps/web/worker/index.ts");
		expect(toPathRef(".decisions/index.md#row")).toBe(".decisions/index.md");
		expect(toPathRef("apps/web/worker/index.ts:71")).toBe("apps/web/worker/index.ts");
		expect(toPathRef("apps/web/worker/env.ts:109:4")).toBe("apps/web/worker/env.ts");
		expect(toPathRef("'apps/web/alchemy.run.ts'")).toBe("apps/web/alchemy.run.ts");
	});
});

describe("toPathRef — rejects non-path tokens (precision over recall, AC #3)", () => {
	it.each([
		["catalog:"],
		["type:bug"],
		["status:triaged"],
		["https://example.com/apps/web"],
		["pnpm dev"],
		["tsgo -b tsconfig.worker.json"],
		["apps/web/**"],
		[".patterns/**"],
		["**/CLAUDE.md"],
		["[triggers]"],
		["scheduled()"],
		["flags.get(key, false)"],
		["@kampus/web"],
		["@effect/tsgo"],
		["and/or"],
		["read/write"],
		["min(login)"],
		["apps/web/work../db/resources.ts"],
		["../sibling/file.ts"],
	])("rejects %s", (tok) => {
		expect(toPathRef(tok)).toBeNull();
	});

	it("rejects an ambiguous bare basename or app-relative shorthand (no known prefix)", () => {
		expect(toPathRef("config.ts")).toBeNull();
		expect(toPathRef("worker/db/resources.ts")).toBeNull();
		expect(toPathRef("README.md")).toBeNull();
	});
});

describe("extractPathRefs — reads inline spans, masks fenced blocks", () => {
	it("pulls path refs from inline code spans with correct 1-based lines", () => {
		const text = [
			"line one",
			"see `apps/web/worker/index.ts` for the entry",
			"and `catalog:` deps",
		].join("\n");
		expect(extractPathRefs(text)).toEqual([{path: "apps/web/worker/index.ts", line: 2}]);
	});

	it("ignores path-looking tokens inside a fenced code block (an example/command)", () => {
		const text = [
			"```bash",
			"cp apps/web/.env.example apps/web/.env",
			"node packages/x/bin.ts",
			"```",
		].join("\n");
		expect(extractPathRefs(text)).toEqual([]);
	});

	it("does not double-count a markdown link target (that is doc-links' job)", () => {
		// A markdown link's target is not inside a code span, so it is not extracted here.
		const text = "[the patterns index](.patterns/index.md) is the map";
		expect(extractPathRefs(text)).toEqual([]);
	});
});

describe("findStalePointersIn — flags only refs the exists predicate rejects", () => {
	const exists = (p: string) => p === "apps/web/worker/index.ts";

	it("returns the stale pointer when the path does not resolve", () => {
		const text = "live `apps/web/worker/index.ts`, dead `apps/web/worker/dom/settings.ts`";
		expect(findStalePointersIn("CLAUDE.md", text, exists)).toEqual([
			{file: "CLAUDE.md", line: 1, path: "apps/web/worker/dom/settings.ts"},
		]);
	});

	it("returns nothing when every pointer resolves", () => {
		const text = "the entry is `apps/web/worker/index.ts`";
		expect(findStalePointersIn("CLAUDE.md", text, exists)).toEqual([]);
	});
});
