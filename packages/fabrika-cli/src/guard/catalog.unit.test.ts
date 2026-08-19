/**
 * The pure rule behind `guard catalog-guard check`, ported from `pipeline-cli`'s
 * `catalog-guard.unit.test.ts` (#2737) — a `catalog:`/`workspace:` ref passes, a hardcoded version
 * is a violation, an allowlisted exception passes, and the line-locator survives the npm names that
 * broke it. Scope and the fail-closed floor are covered in `catalog-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	type AllowlistEntry,
	cleanSummary,
	findDepLine,
	findViolations,
	manifestDeps,
	type PackageManifest,
	violationAnnotations,
	violationReport,
} from "./catalog.ts";

const VERB = "guard catalog-guard check";

const manifest = (path: string, deps: PackageManifest["deps"]): PackageManifest => ({path, deps});

describe("findViolations", () => {
	it("passes every dep on catalog: (incl. a named catalog)", () => {
		expect(
			findViolations([
				manifest("packages/a/package.json", [
					{field: "dependencies", name: "react", value: "catalog:"},
					{field: "devDependencies", name: "vite", value: "catalog:react"},
				]),
			]),
		).toEqual([]);
	});

	it("passes a workspace:* internal dep", () => {
		expect(
			findViolations([
				manifest("packages/a/package.json", [
					{field: "dependencies", name: "@kampus/db-schema", value: "workspace:*"},
				]),
			]),
		).toEqual([]);
	});

	it("flags a hardcoded semver, carrying the offending dep as the evidence", () => {
		expect(
			findViolations([
				manifest("packages/a/package.json", [
					{field: "dependencies", name: "bar", value: "^1.2.3"},
				]),
			]),
		).toEqual([
			{path: "packages/a/package.json", field: "dependencies", name: "bar", value: "^1.2.3"},
		]);
	});

	it("passes a hardcoded dep that is on the explicit allowlist", () => {
		const allowlist: ReadonlyArray<AllowlistEntry> = [
			{name: "bar", reason: "unavoidable — no published catalog build yet"},
		];
		expect(
			findViolations(
				[
					manifest("packages/a/package.json", [
						{field: "dependencies", name: "bar", value: "^1.2.3"},
					]),
				],
				allowlist,
			),
		).toEqual([]);
	});

	it("scopes a path-qualified allowlist entry to that manifest only", () => {
		const allowlist: ReadonlyArray<AllowlistEntry> = [
			{name: "bar", path: "packages/a/package.json", reason: "scoped exception"},
		];
		expect(
			findViolations(
				[
					manifest("packages/a/package.json", [
						{field: "dependencies", name: "bar", value: "^1.2.3"},
					]),
					manifest("packages/b/package.json", [
						{field: "dependencies", name: "bar", value: "^1.2.3"},
					]),
				],
				allowlist,
			),
		).toEqual([
			{path: "packages/b/package.json", field: "dependencies", name: "bar", value: "^1.2.3"},
		]);
	});
});

describe("manifestDeps", () => {
	it("reads dependencies / devDependencies / peerDependencies and ignores others", () => {
		expect(
			manifestDeps({
				dependencies: {a: "catalog:"},
				devDependencies: {b: "^1.0.0"},
				peerDependencies: {c: "workspace:*"},
				optionalDependencies: {d: "^2.0.0"},
				scripts: {build: "tsc"},
			}),
		).toEqual([
			{field: "dependencies", name: "a", value: "catalog:"},
			{field: "devDependencies", name: "b", value: "^1.0.0"},
			{field: "peerDependencies", name: "c", value: "workspace:*"},
		]);
	});
});

describe("the reports", () => {
	it("summarises a clean scan with the scope it actually covered", () => {
		expect(cleanSummary(VERB, 1)).toContain("all deps in 1 workspace manifest are");
		expect(cleanSummary(VERB, 4)).toContain("all deps in 4 workspace manifests are");
	});

	it("names each offender, the #535 root cause and the catalog fix", () => {
		const report = violationReport(
			VERB,
			[{path: "packages/a/package.json", field: "dependencies", name: "bar", value: "^1.2.3"}],
			3,
		);
		expect(report).toContain("1 dependency pin");
		expect(report).toContain("of 3 manifests scanned");
		expect(report).toContain("packages/a/package.json: dependencies `bar` pins `^1.2.3`");
		expect(report).toContain("#535");
		expect(report).toContain("pnpm-workspace.yaml");
	});
});

describe("findDepLine", () => {
	const text = [
		"{",
		'\t"name": "x",',
		'\t"dependencies": {',
		'\t\t"a": "catalog:",',
		'\t\t"b": "^1.0.0"',
		"\t}",
		"}",
	].join("\n");

	it("finds the 1-based line of a dep inside its field block", () => {
		expect(findDepLine(text, "dependencies", "b")).toBe(5);
	});

	it("returns null for a dep that is not in that field block", () => {
		expect(findDepLine(text, "devDependencies", "b")).toBeNull();
		expect(findDepLine(text, "dependencies", "name")).toBeNull();
	});

	// `.` is legal in an npm name (this repo has `@distilled.cloud/cloudflare`), so an unescaped
	// name compiled into a RegExp matched a neighbour one line up.
	it("does not let a `.` in a dep name match a neighbouring dep", () => {
		const dotted = [
			"{",
			'\t"dependencies": {',
			'\t\t"aXb/pkg": "catalog:",',
			'\t\t"a.b/pkg": "^1.0.0"',
			"\t}",
			"}",
		].join("\n");
		expect(findDepLine(dotted, "dependencies", "a.b/pkg")).toBe(4);
	});

	// A regex-metacharacter key used to throw a SyntaxError out of the annotation build, which took
	// the whole guard report with it.
	it("does not throw on a dep name carrying a regex metacharacter", () => {
		const weird = ["{", '\t"dependencies": {', '\t\t"a(b": "^1.0.0"', "\t}", "}"].join("\n");
		expect(() => findDepLine(weird, "dependencies", "a(b")).not.toThrow();
		expect(findDepLine(weird, "dependencies", "a(b")).toBe(3);
		expect(() => findDepLine(weird, "dependencies*", "zzz")).not.toThrow();
	});

	it("finds a dep declared on the same line as its field", () => {
		const compact = [
			"{",
			'\t"dependencies": {"x": "1"},',
			'\t"devDependencies": {',
			'\t\t"x": "2"',
			"\t}",
			"}",
		].join("\n");
		expect(findDepLine(compact, "dependencies", "x")).toBe(2);
		expect(findDepLine(compact, "devDependencies", "x")).toBe(4);
	});

	it("returns null when a compact field block closes without the dep", () => {
		const compact = [
			"{",
			'\t"dependencies": {"y": "1"},',
			'\t"devDependencies": {"x": "2"}',
			"}",
		].join("\n");
		expect(findDepLine(compact, "dependencies", "x")).toBeNull();
	});
});

describe("violationAnnotations", () => {
	const violations = [
		{path: "packages/a/package.json", field: "dependencies", name: "foo", value: "^1.0.0"},
	];

	it("annotates nothing when there is nothing to annotate", () => {
		expect(violationAnnotations([])).toEqual([]);
	});

	it("annotates a violation on the manifest line when the resolver finds one", () => {
		expect(violationAnnotations(violations, () => 7)[0]?.location).toEqual({
			_tag: "Line",
			file: "packages/a/package.json",
			line: 7,
		});
	});

	it("falls back to a file-level annotation when the line is unknown", () => {
		expect(violationAnnotations(violations)[0]?.location).toEqual({
			_tag: "File",
			file: "packages/a/package.json",
		});
	});
});
