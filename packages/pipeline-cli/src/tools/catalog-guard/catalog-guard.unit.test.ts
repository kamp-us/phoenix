/**
 * `catalog-guard` pure-core tests (#2737) — the verdict logic over already-gathered
 * manifest facts: a `catalog:` / `workspace:` ref passes, a hardcoded version fails,
 * an allowlisted exception passes, and an empty scope fails closed (ADR 0092). No
 * disk — the IO seam is covered in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type AllowlistEntry,
	judge,
	manifestDeps,
	type PackageManifest,
	parseWorkspacePackageGlobs,
} from "./catalog-guard.ts";

const manifest = (path: string, deps: PackageManifest["deps"]): PackageManifest => ({path, deps});

describe("judge — the catalog verdict", () => {
	it("PASSES when every dep is on catalog: (incl. a named catalog)", () => {
		const v = judge([
			manifest("packages/a/package.json", [
				{field: "dependencies", name: "react", value: "catalog:"},
				{field: "devDependencies", name: "vite", value: "catalog:react"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("PASSES a workspace:* internal dep", () => {
		const v = judge([
			manifest("packages/a/package.json", [
				{field: "dependencies", name: "@kampus/db-schema", value: "workspace:*"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("FAILS on a hardcoded semver, with the offending dep in the evidence", () => {
		const v = judge([
			manifest("packages/a/package.json", [{field: "dependencies", name: "bar", value: "^1.2.3"}]),
		]);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "hardcoded-versions") throw new Error("expected hardcoded-versions");
		expect(v.violations).toEqual([
			{path: "packages/a/package.json", field: "dependencies", name: "bar", value: "^1.2.3"},
		]);
	});

	it("FAILS (fail-closed, zero-scope) when no manifests are in scope", () => {
		const v = judge([]);
		expect(v.pass).toBe(false);
		if (v.pass) throw new Error("expected fail");
		expect(v.reason).toBe("zero-scope");
	});

	it("PASSES a hardcoded dep that is on the explicit allowlist", () => {
		const allowlist: ReadonlyArray<AllowlistEntry> = [
			{name: "bar", reason: "unavoidable — no published catalog build yet"},
		];
		const v = judge(
			[
				manifest("packages/a/package.json", [
					{field: "dependencies", name: "bar", value: "^1.2.3"},
				]),
			],
			allowlist,
		);
		expect(v.pass).toBe(true);
	});

	it("scopes a path-qualified allowlist entry to that manifest only", () => {
		const allowlist: ReadonlyArray<AllowlistEntry> = [
			{name: "bar", path: "packages/a/package.json", reason: "scoped exception"},
		];
		const v = judge(
			[
				manifest("packages/a/package.json", [
					{field: "dependencies", name: "bar", value: "^1.2.3"},
				]),
				manifest("packages/b/package.json", [
					{field: "dependencies", name: "bar", value: "^1.2.3"},
				]),
			],
			allowlist,
		);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "hardcoded-versions") throw new Error("expected hardcoded-versions");
		// only packages/b's `bar` remains a violation — packages/a's is exempted by the scoped entry
		expect(v.violations).toEqual([
			{path: "packages/b/package.json", field: "dependencies", name: "bar", value: "^1.2.3"},
		]);
	});
});

describe("manifestDeps — flatten governed dep fields", () => {
	it("reads dependencies / devDependencies / peerDependencies and ignores others", () => {
		const deps = manifestDeps({
			dependencies: {a: "catalog:"},
			devDependencies: {b: "^1.0.0"},
			peerDependencies: {c: "workspace:*"},
			optionalDependencies: {d: "^2.0.0"},
			scripts: {build: "tsc"},
		});
		expect(deps).toEqual([
			{field: "dependencies", name: "a", value: "catalog:"},
			{field: "devDependencies", name: "b", value: "^1.0.0"},
			{field: "peerDependencies", name: "c", value: "workspace:*"},
		]);
	});
});

describe("parseWorkspacePackageGlobs", () => {
	it("reads the packages: block and stops at the next top-level key", () => {
		const globs = parseWorkspacePackageGlobs(
			"packages:\n  - packages/*\n  - apps/*\n  - infra/*\n\ncatalog:\n  react: 19.0.0\n",
		);
		expect(globs).toEqual(["packages/*", "apps/*", "infra/*"]);
	});
});
