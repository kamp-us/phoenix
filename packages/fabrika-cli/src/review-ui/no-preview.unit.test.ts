import {describe, expect, it} from "vitest";
import {fileMode, filesAtMode, type NoPreviewRule, noPreviewMode} from "./no-preview.ts";

const ADMIN: NoPreviewRule = {paths: ["apps/admin/**"], mode: "hand-check"};
const DOCS: NoPreviewRule = {paths: ["apps/site/src/docs/**"], mode: "skip"};

describe("noPreviewMode", () => {
	it("is require-render for a repo that declares no rules", () => {
		expect(noPreviewMode([], ["apps/site/src/page.tsx"])).toBe("require-render");
	});

	it("takes the matching rule's mode", () => {
		expect(noPreviewMode([ADMIN], ["apps/admin/src/page/row.tsx"])).toBe("hand-check");
		expect(noPreviewMode([DOCS], ["apps/site/src/docs/intro.mdx"])).toBe("skip");
	});

	it("reads an unmatched file as require-render", () => {
		expect(noPreviewMode([ADMIN], ["apps/site/src/page.tsx"])).toBe("require-render");
	});

	it("lets the first matching rule win for a file", () => {
		const first: NoPreviewRule = {paths: ["apps/**"], mode: "skip"};
		expect(fileMode([first, ADMIN], "apps/admin/src/a.tsx")).toBe("skip");
		expect(fileMode([ADMIN, first], "apps/admin/src/a.tsx")).toBe("hand-check");
	});

	it("matches any of a rule's globs", () => {
		const rule: NoPreviewRule = {paths: ["docs/**", "site/*.css"], mode: "skip"};
		expect(fileMode([rule], "site/theme.css")).toBe("skip");
		expect(fileMode([rule], "site/nested/theme.css")).toBe("require-render");
	});

	it("takes the strictest mode across a mixed PR", () => {
		const skipped = "apps/site/src/docs/intro.mdx";
		const handChecked = "apps/admin/src/page/row.tsx";
		const unmatched = "apps/site/src/page.tsx";
		expect(noPreviewMode([ADMIN, DOCS], [skipped, handChecked])).toBe("hand-check");
		expect(noPreviewMode([ADMIN, DOCS], [skipped, handChecked, unmatched])).toBe("require-render");
		expect(noPreviewMode([ADMIN, DOCS], [skipped])).toBe("skip");
	});

	it("resolves an empty file list to require-render, the answer that loosens nothing", () => {
		expect(noPreviewMode([DOCS], [])).toBe("require-render");
	});
});

describe("filesAtMode", () => {
	it("names the files that set the PR's mode", () => {
		const files = ["apps/site/src/docs/intro.mdx", "apps/admin/src/page/row.tsx"];
		expect(filesAtMode([ADMIN, DOCS], files, "hand-check")).toEqual([
			"apps/admin/src/page/row.tsx",
		]);
	});
});
