import {describe, expect, it} from "vitest";
import {
	extractInternalLinks,
	findDeadLinksIn,
	findRootDir,
	isExternal,
	maskCode,
	renderReport,
	stripFragment,
} from "./doc-links.ts";

describe("isExternal", () => {
	it.each([
		["https://x.com", true],
		["http://x.com", true],
		["mailto:a@b.c", true],
		["tel:+1", true],
		["#section", true],
		["//cdn.example.com/x", true],
		["./foo.md", false],
		["../bar/baz.ts", false],
		["/repo-absolute.md", false],
		["foo.md", false],
	])("%s -> %s", (target, expected) => {
		expect(isExternal(target)).toBe(expected);
	});
});

describe("stripFragment", () => {
	it("drops #fragment and ?query", () => {
		expect(stripFragment("a.md#sec")).toBe("a.md");
		expect(stripFragment("a.md?v=1")).toBe("a.md");
		expect(stripFragment("a.md#sec?v=1")).toBe("a.md");
		expect(stripFragment("a.md")).toBe("a.md");
	});
});

describe("maskCode", () => {
	it("masks inline code spans but preserves line count", () => {
		const out = maskCode("see `[x](y.md)` here\nand [real](r.md)");
		expect(out).not.toContain("[x](y.md)");
		expect(out).toContain("[real](r.md)");
		expect(out.split("\n").length).toBe(2);
	});

	it("masks multi-backtick spans (` `` ` containing a backtick)", () => {
		expect(maskCode("a ``[x](y.md)`` b")).not.toContain("[x](y.md)");
	});

	it("masks fenced code blocks", () => {
		const text = "intro\n```\n[x](dead.md)\n```\noutro [real](r.md)";
		const out = maskCode(text);
		expect(out).not.toContain("[x](dead.md)");
		expect(out).toContain("[real](r.md)");
	});

	it("masks ~~~ fences too", () => {
		expect(maskCode("~~~\n[x](y.md)\n~~~")).not.toContain("[x](y.md)");
	});
});

describe("extractInternalLinks", () => {
	it("pulls internal links with correct 1-based line numbers", () => {
		const text = "line1\n[a](./a.md) and [b](../b.ts)\nline3";
		expect(extractInternalLinks(text)).toEqual([
			{target: "./a.md", line: 2},
			{target: "../b.ts", line: 2},
		]);
	});

	it("skips external + anchor + empty targets", () => {
		const text = "[ext](https://x.com) [anchor](#s) [empty]() [ok](./ok.md)";
		expect(extractInternalLinks(text)).toEqual([{target: "./ok.md", line: 1}]);
	});

	it("ignores links written inside code (the doc-example false positive)", () => {
		// This is the exact shape that broke a naive checker: CLAUDE.md's
		// `[text](relative/path.md)` example and the /adr `[NNNN](NNNN-slug.md)` template.
		const text = "Use `[text](relative/path.md)` not wikilinks. [real](./r.md)";
		expect(extractInternalLinks(text)).toEqual([{target: "./r.md", line: 1}]);
	});

	it("keeps the path part of a fragment/query link (resolution strips it later)", () => {
		expect(extractInternalLinks("[x](./a.md#sec)")).toEqual([{target: "./a.md#sec", line: 1}]);
	});
});

describe("findDeadLinksIn", () => {
	const exists = (_file: string, target: string) => target === "alive.md";

	it("flags only links whose stripped target does not exist", () => {
		const text = "[a](alive.md) [b](alive.md#sec) [c](dead.md)";
		expect(findDeadLinksIn("doc.md", text, exists)).toEqual([
			{file: "doc.md", line: 1, target: "dead.md"},
		]);
	});

	it("passes the fragment-stripped target to the exists predicate", () => {
		const seen: string[] = [];
		findDeadLinksIn("doc.md", "[a](alive.md#frag)", (_f, t) => {
			seen.push(t);
			return true;
		});
		expect(seen).toEqual(["alive.md"]);
	});

	it("returns nothing for a clean doc", () => {
		expect(findDeadLinksIn("doc.md", "[a](alive.md)", exists)).toEqual([]);
	});
});

describe("renderReport", () => {
	it("singularizes one dead link and lists file:line → target", () => {
		const r = renderReport([{file: "a.md", line: 3, target: "x.md"}]);
		expect(r).toContain("1 dead internal doc link ");
		expect(r).toContain("a.md:3  →  x.md");
	});

	it("pluralizes multiple", () => {
		const r = renderReport([
			{file: "a.md", line: 1, target: "x.md"},
			{file: "b.md", line: 2, target: "y.md"},
		]);
		expect(r).toContain("2 dead internal doc links ");
	});
});

describe("findRootDir", () => {
	const dirname = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");

	it("walks up to the first marker-bearing ancestor", () => {
		const markers = new Set(["/repo"]);
		expect(findRootDir("/repo/packages/x", (d) => markers.has(d), dirname)).toBe("/repo");
	});

	it("returns null when no marker is found before the fs root", () => {
		expect(findRootDir("/a/b/c", () => false, dirname)).toBeNull();
	});
});
