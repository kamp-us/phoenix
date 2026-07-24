/**
 * `publish-isolation-guard` pure-core tests (ADR 0201 §3, #3802) — the verdict logic
 * over already-gathered facts: a clean runtime dep set passes, a `workspace:*` link or
 * a private/unpublished `@kampus/*` dep fails, a published `@kampus/*` sibling passes,
 * and an empty published set fails closed (ADR 0092). Plus the two derivation helpers:
 * parsing publish.yml's tag grammar and mapping prefixes onto members. No disk — the
 * IO seam is covered in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	judge,
	manifestRuntimeDeps,
	type PublishedManifest,
	parsePublishedTagPrefixes,
	resolvePublished,
	unscopedName,
} from "./publish-isolation-guard.ts";

const manifest = (
	path: string,
	name: string,
	deps: PublishedManifest["deps"],
): PublishedManifest => ({path, name, deps});

describe("judge — the publish-isolation verdict", () => {
	it("PASSES when every runtime dep is a public/catalog registry dep", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "effect", value: "catalog:"},
				{field: "dependencies", name: "@effect/platform-node", value: "catalog:"},
				{field: "dependencies", name: "yaml", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("PASSES the current pipeline-crew-mcp-shaped clean graph", () => {
		const v = judge([
			manifest("packages/pipeline-crew-mcp/package.json", "@kampus/pipeline-crew-mcp", [
				{field: "dependencies", name: "@effect/platform-node", value: "catalog:"},
				{field: "dependencies", name: "effect", value: "catalog:"},
				{field: "dependencies", name: "proper-lockfile", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("FAILS on a workspace:* link, with kind workspace-link in the evidence (the #3802 class)", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/epic-ledger", value: "workspace:*"},
			]),
		]);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "linked-private-deps")
			throw new Error("expected linked-private-deps");
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

	it("FAILS on a private @kampus dep pinned to a version (not published, not workspace:)", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/leak-guard", value: "^1.0.0"},
			]),
		]);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "linked-private-deps")
			throw new Error("expected linked-private-deps");
		expect(v.violations[0]?.kind).toBe("private-kampus-dep");
	});

	it("scans optionalDependencies and peerDependencies, not just dependencies", () => {
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "optionalDependencies", name: "@kampus/optional-private", value: "workspace:*"},
				{field: "peerDependencies", name: "@kampus/peer-private", value: "^2.0.0"},
			]),
		]);
		expect(v.pass).toBe(false);
		if (v.pass || v.reason !== "linked-private-deps")
			throw new Error("expected linked-private-deps");
		expect(v.violations.map((x) => x.field).sort()).toEqual([
			"optionalDependencies",
			"peerDependencies",
		]);
	});

	it("PASSES a @kampus dep that is ITSELF in the published set", () => {
		// Two published packages; one depends on the other by a registry version — resolvable.
		const v = judge([
			manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", [
				{field: "dependencies", name: "@kampus/pipeline-crew-mcp", value: "^0.1.0"},
			]),
			manifest("packages/pipeline-crew-mcp/package.json", "@kampus/pipeline-crew-mcp", [
				{field: "dependencies", name: "effect", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("FAILS (fail-closed, zero-scope) when no published packages are in scope", () => {
		const v = judge([]);
		expect(v.pass).toBe(false);
		if (v.pass) throw new Error("expected fail");
		expect(v.reason).toBe("zero-scope");
	});
});

describe("parsePublishedTagPrefixes — derive the published set from publish.yml", () => {
	it("extracts the prefix from a `^<prefix>-v(...)` release-tag regex", () => {
		const yaml = 'if [[ ! "$TAG" =~ ^pipeline-cli-v([0-9].*)$ ]]; then';
		expect(parsePublishedTagPrefixes(yaml)).toEqual(["pipeline-cli"]);
	});

	it("ignores bare `pipeline-cli-v<version>` prose mentions (no ^ anchor, no capture group)", () => {
		const yaml = "# Release tag grammar: `pipeline-cli-v<version>` (e.g. `pipeline-cli-v0.1.0`)";
		expect(parsePublishedTagPrefixes(yaml)).toEqual([]);
	});

	it("dedupes and sorts multiple distinct prefixes", () => {
		const yaml =
			"=~ ^pipeline-crew-mcp-v([0-9].*)$ ... =~ ^pipeline-cli-v([0-9].*)$ ... =~ ^pipeline-cli-v(.*)$";
		expect(parsePublishedTagPrefixes(yaml)).toEqual(["pipeline-cli", "pipeline-crew-mcp"]);
	});
});

describe("resolvePublished — map prefixes onto members by unscoped name", () => {
	const members: ReadonlyArray<PublishedManifest> = [
		manifest("packages/pipeline-cli/package.json", "@kampus/pipeline-cli", []),
		manifest("packages/pipeline-crew-mcp/package.json", "@kampus/pipeline-crew-mcp", []),
		manifest("apps/web/package.json", "@kampus/web", []),
	];

	it("resolves a prefix to the member whose unscoped name matches", () => {
		const {published, unmatchedPrefixes} = resolvePublished(["pipeline-cli"], members);
		expect(published.map((m) => m.name)).toEqual(["@kampus/pipeline-cli"]);
		expect(unmatchedPrefixes).toEqual([]);
	});

	it("surfaces a prefix with no matching member as drift (fail-closed signal)", () => {
		const {published, unmatchedPrefixes} = resolvePublished(["does-not-exist"], members);
		expect(published).toEqual([]);
		expect(unmatchedPrefixes).toEqual(["does-not-exist"]);
	});
});

describe("manifestRuntimeDeps — runtime fields only", () => {
	it("reads dependencies / optionalDependencies / peerDependencies and IGNORES devDependencies", () => {
		const deps = manifestRuntimeDeps({
			dependencies: {a: "catalog:"},
			optionalDependencies: {b: "^1.0.0"},
			peerDependencies: {c: "workspace:*"},
			devDependencies: {d: "workspace:*"},
			scripts: {build: "tsc"},
		});
		expect(deps).toEqual([
			{field: "dependencies", name: "a", value: "catalog:"},
			{field: "optionalDependencies", name: "b", value: "^1.0.0"},
			{field: "peerDependencies", name: "c", value: "workspace:*"},
		]);
	});
});

describe("unscopedName", () => {
	it("strips the @scope/ prefix", () => {
		expect(unscopedName("@kampus/pipeline-cli")).toBe("pipeline-cli");
	});
	it("returns an unscoped name unchanged", () => {
		expect(unscopedName("effect")).toBe("effect");
	});
});
