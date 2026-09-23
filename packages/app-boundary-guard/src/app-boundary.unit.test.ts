import {describe, expect, it} from "vitest";

import {
	APP_SCOPE,
	dependencyFindings,
	EXIT,
	importFindings,
	isApp,
	judge,
	parseManifest,
	parseWorkspaceGlobs,
	render,
} from "./app-boundary.ts";

// Built from the constant so this file never holds an import-shaped app specifier of its own,
// which the guard would read as a real import when it walks this package.
const app = (name: string): string => `${APP_SCOPE}${name}`;

describe("dependencyFindings", () => {
	it.each([
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	])("names the package and the field for an app listed in %s", (field) => {
		const manifest = {
			name: "@kampus/foo",
			[field]: {[app("tuval")]: "workspace:*", effect: "catalog:"},
		};
		expect(dependencyFindings("packages/foo/package.json", manifest)).toEqual([
			{
				_tag: "Dependency",
				manifest: "packages/foo/package.json",
				packageName: "@kampus/foo",
				field,
				dependency: app("tuval"),
			},
		]);
	});

	it("falls back to the manifest path when the package declares no name", () => {
		const [finding] = dependencyFindings("package.json", {devDependencies: {[app("web")]: "*"}});
		expect(finding).toMatchObject({packageName: "package.json", field: "devDependencies"});
	});

	it("passes a manifest whose names only share a prefix with the app scope", () => {
		const manifest = {dependencies: {"@kampus/tuval-sdk": "workspace:*", "@kampus-appsx/y": "1"}};
		expect(dependencyFindings("packages/foo/package.json", manifest)).toEqual([]);
	});
});

describe("parseManifest", () => {
	it("reads a JSON object and refuses anything else", () => {
		expect(parseManifest('{"name": "x"}')).toEqual({name: "x"});
		expect(parseManifest("[1]")).toBeNull();
		expect(parseManifest("{not json")).toBeNull();
	});
});

describe("importFindings", () => {
	it.each([
		["a static import", `import {x} from "${app("tuval")}/kernel";`],
		["a type import", `import type {X} from '${app("tuval")}';`],
		["a re-export", `export * from "${app("tuval")}";`],
		["a side-effect import", `import "${app("tuval")}/boot";`],
		["a dynamic import", `const m = await import("${app("tuval")}");`],
		["a require", `const m = require("${app("tuval")}");`],
		["a vitest module double", `vi.mock("${app("tuval")}", () => ({}));`],
	])("names the file and line for %s", (_, statement) => {
		const findings = importFindings("packages/foo/src/a.ts", `// header\n\n${statement}\n`);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({_tag: "Import", file: "packages/foo/src/a.ts", line: 3});
	});

	it("finds a specifier on the closing line of a multi-line import", () => {
		const text = `import {\n\ta,\n\tb,\n} from "${app("tuval")}/kernel";\n`;
		expect(importFindings("f.ts", text)).toEqual([
			{_tag: "Import", file: "f.ts", line: 4, specifier: app("tuval/kernel")},
		]);
	});

	it("passes a string that names an app outside an import position", () => {
		const text = `const scope = "${APP_SCOPE}";\nexpect(s.startsWith("${app("")}")).toBe(true);\n`;
		expect(importFindings("f.ts", text)).toEqual([]);
	});

	it("passes imports of packages", () => {
		expect(importFindings("f.ts", `import {x} from "@kampus/tuval-sdk/kernel";`)).toEqual([]);
	});
});

describe("parseWorkspaceGlobs", () => {
	it("reads the packages: block and stops at the next key", () => {
		const yaml = `packages:\n  - packages/*\n  - 'apps/*'\n  # a note\n  - infra/depo\n\ncatalog:\n  x: 1\n`;
		expect(parseWorkspaceGlobs(yaml)).toEqual({
			_tag: "Read",
			globs: [
				{_tag: "Children", dir: "packages"},
				{_tag: "Children", dir: "apps"},
				{_tag: "Exact", dir: "infra/depo"},
			],
		});
	});

	it.each([
		"!packages/private",
		"packages/**",
		"packages/{a,b}",
	])("refuses %s rather than guessing at its members", (glob) => {
		expect(parseWorkspaceGlobs(`packages:\n  - ${glob}\n`)._tag).toBe("Unreadable");
	});

	it("refuses a workspace with no packages: entries", () => {
		expect(parseWorkspaceGlobs("catalog:\n  x: 1\n")._tag).toBe("Unreadable");
	});
});

describe("isApp", () => {
	it("is true only under apps/", () => {
		expect(isApp("apps/tuval")).toBe(true);
		expect(isApp("packages/apps")).toBe(false);
		expect(isApp("appsx/y")).toBe(false);
	});
});

describe("judge and render", () => {
	const finding = importFindings("packages/foo/src/a.ts", `import "${app("tuval")}";`);

	it("is clean only over a non-empty scope with nothing unread", () => {
		const verdict = judge({packages: 3, files: 10, findings: [], unread: []});
		expect(verdict).toEqual({_tag: "Clean", packages: 3, files: 10});
		expect(render(verdict).exitCode).toBe(EXIT.clean);
	});

	it("reds on a finding and names it", () => {
		const {exitCode, text} = render(judge({packages: 3, files: 10, findings: finding, unread: []}));
		expect(exitCode).toBe(EXIT.violated);
		expect(text).toContain("packages/foo/src/a.ts:1");
	});

	it("reds on a finding even when part of the scope was unread", () => {
		const verdict = judge({packages: 3, files: 10, findings: finding, unread: ["x"]});
		expect(verdict._tag).toBe("Violated");
	});

	it.each([
		{packages: 0, files: 10, unread: []},
		{packages: 3, files: 0, unread: []},
		{packages: 3, files: 10, unread: ["packages/bar/package.json does not parse"]},
	])("is UNKNOWN, never clean, over %o", (scan) => {
		const {exitCode} = render(judge({...scan, findings: []}));
		expect(exitCode).toBe(EXIT.unknown);
	});
});
