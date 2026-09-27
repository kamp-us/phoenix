import {describe, expect, it} from "vitest";

import {parseMember, parseWorkspaceRoots} from "./workspace.ts";

describe("parseWorkspaceRoots", () => {
	it("reads the one-level globs of the packages list and stops at the next key", () => {
		const yaml = [
			"packages:",
			"  - packages/*",
			"  # a comment",
			"  - 'apps/*'",
			'  - "infra/*" # stacks',
			"",
			"catalog:",
			"  - not/*",
		].join("\n");
		expect(parseWorkspaceRoots(yaml)).toEqual(["packages", "apps", "infra"]);
	});

	it.each([
		"packages/**",
		"!packages/x",
		"packages/foo",
	])("throws on the unsupported glob %s", (glob) => {
		expect(() => parseWorkspaceRoots(`packages:\n  - ${glob}\n`)).toThrow();
	});

	it("throws when there is no packages list or it is empty", () => {
		expect(() => parseWorkspaceRoots("catalog:\n  a: 1\n")).toThrow();
		expect(() => parseWorkspaceRoots("packages:\ncatalog:\n")).toThrow();
	});
});

describe("parseMember", () => {
	it("collects every dependency kind and whether a test script exists", () => {
		const manifest = JSON.stringify({
			name: "@kampus/x",
			scripts: {test: "vitest run"},
			dependencies: {"@kampus/a": "workspace:*"},
			devDependencies: {vitest: "catalog:"},
			peerDependencies: {"@kampus/b": "*"},
		});
		expect(parseMember("packages/x", manifest)).toEqual({
			name: "@kampus/x",
			dir: "packages/x",
			dependencies: ["@kampus/a", "vitest", "@kampus/b"],
			hasTest: true,
		});
	});

	it("marks a manifest without a test script", () => {
		expect(parseMember("packages/x", JSON.stringify({name: "@kampus/x"})).hasTest).toBe(false);
	});

	it("throws on a nameless manifest or a malformed dependency block", () => {
		expect(() => parseMember("packages/x", "{}")).toThrow();
		expect(() =>
			parseMember("packages/x", JSON.stringify({name: "x", dependencies: []})),
		).toThrow();
		expect(() => parseMember("packages/x", "not json")).toThrow();
	});
});
