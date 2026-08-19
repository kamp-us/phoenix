/**
 * The pure rule behind `guard publish-isolation-guard check`, ported from `pipeline-cli`'s
 * `publish-isolation-guard.unit.test.ts` (ADR 0201 §3, #3802): the verdict over already-gathered
 * facts, plus the two derivation helpers — parsing publish.yml's tag grammar, and mapping prefixes
 * onto members. No disk; the IO seam is covered in `publish-isolation-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	judge,
	manifestRuntimeDeps,
	type PublishedManifest,
	parsePublishedTagPrefixes,
	resolvePublished,
	unscopedName,
} from "./publish-isolation.ts";

const manifest = (
	path: string,
	name: string,
	deps: PublishedManifest["deps"],
): PublishedManifest => ({path, name, deps});

describe("judge", () => {
	it("passes when every runtime dep is a public/catalog registry dep", () => {
		const v = judge([
			manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", [
				{field: "dependencies", name: "effect", value: "catalog:"},
				{field: "dependencies", name: "@effect/platform-node", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("reds a workspace:* link as the #3802 class", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/epic-ledger", value: "workspace:*"},
			]),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations).toEqual([
			{
				path: "packages/pipeline-cli/package.json",
				field: "dependencies",
				name: "@kampus/epic-ledger",
				value: "workspace:*",
				kind: "workspace-link",
			},
		]);
	});

	it("reds a private @kampus dep pinned to a version", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/leak-guard", value: "^1.0.0"},
			]),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations[0]?.kind).toBe("private-kampus-dep");
	});

	it("scans optionalDependencies and peerDependencies, not just dependencies", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "optionalDependencies", name: "@kampus/optional-private", value: "workspace:*"},
				{field: "peerDependencies", name: "@kampus/peer-private", value: "^2.0.0"},
			]),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations.map((x) => x.field).sort()).toEqual([
			"optionalDependencies",
			"peerDependencies",
		]);
	});

	// A published sibling resolves from the registry, so it is not the #3802 class.
	it("passes a @kampus dep that is ITSELF in the published set", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/fabrika-cli", value: "^0.1.0"},
			]),
			manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", [
				{field: "dependencies", name: "effect", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("fails closed when no published packages are in scope", () => {
		const v = judge([]);
		if (v.pass) throw new Error("expected a failure");
		expect(v.reason).toBe("zero-scope");
	});
});

describe("parsePublishedTagPrefixes", () => {
	it("extracts the prefix from a `^<prefix>-v(...)` release-tag regex", () => {
		expect(
			parsePublishedTagPrefixes('if [[ ! "$TAG" =~ ^fabrika-cli-v([0-9].*)$ ]]; then'),
		).toEqual(["fabrika-cli"]);
	});

	it("ignores a bare `<name>-v<version>` prose mention — no ^ anchor, no capture group", () => {
		expect(
			parsePublishedTagPrefixes(
				"# Release tag grammar: `fabrika-cli-v<version>` (e.g. `fabrika-cli-v0.1.0`)",
			),
		).toEqual([]);
	});

	it("dedupes and sorts multiple distinct prefixes", () => {
		expect(
			parsePublishedTagPrefixes(
				"=~ ^pipeline-cli-v([0-9].*)$ ... =~ ^fabrika-cli-v([0-9].*)$ ... =~ ^fabrika-cli-v(.*)$",
			),
		).toEqual(["fabrika-cli", "pipeline-cli"]);
	});
});

describe("resolvePublished", () => {
	const members: ReadonlyArray<PublishedManifest> = [
		manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", []),
		manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", []),
		manifest("apps/web/package.json", "@kampus/web", []),
	];

	it("resolves a prefix to the member whose unscoped name matches", () => {
		const {published, unmatchedPrefixes} = resolvePublished(["pipeline-cli"], members);
		expect(published.map((m) => m.name)).toEqual(["@kampus/pipeline-cli"]);
		expect(unmatchedPrefixes).toEqual([]);
	});

	it("surfaces a prefix with no matching member as drift", () => {
		const {published, unmatchedPrefixes} = resolvePublished(["does-not-exist"], members);
		expect(published).toEqual([]);
		expect(unmatchedPrefixes).toEqual(["does-not-exist"]);
	});
});

describe("manifestRuntimeDeps", () => {
	// devDependencies never ship in the tarball, so a private link there cannot break an install.
	it("reads the three runtime fields and IGNORES devDependencies", () => {
		expect(
			manifestRuntimeDeps({
				dependencies: {a: "catalog:"},
				optionalDependencies: {b: "^1.0.0"},
				peerDependencies: {c: "workspace:*"},
				devDependencies: {d: "workspace:*"},
				scripts: {build: "tsc"},
			}),
		).toEqual([
			{field: "dependencies", name: "a", value: "catalog:"},
			{field: "optionalDependencies", name: "b", value: "^1.0.0"},
			{field: "peerDependencies", name: "c", value: "workspace:*"},
		]);
	});
});

describe("unscopedName", () => {
	it("strips the @scope/ prefix", () => {
		expect(unscopedName("@kampus/fabrika-cli")).toBe("fabrika-cli");
	});
	it("returns an unscoped name unchanged", () => {
		expect(unscopedName("effect")).toBe("effect");
	});
});
