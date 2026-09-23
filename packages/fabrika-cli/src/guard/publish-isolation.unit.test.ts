/**
 * The pure rule behind `guard publish-isolation-guard check`, ported from the v1 CLI's
 * `publish-isolation-guard.unit.test.ts`: the verdict over already-gathered
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
	workspaceLink,
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

	it("reds a workspace:* link — it never resolves from a registry", () => {
		const v = judge([
			manifest("packages/demo-cli/package.json", "@kampus/demo-cli", [
				{field: "dependencies", name: "@kampus/epic-ledger", value: "workspace:*"},
			]),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations).toEqual([
			{
				path: "packages/demo-cli/package.json",
				field: "dependencies",
				name: "@kampus/epic-ledger",
				value: "workspace:*",
				kind: "workspace-link",
			},
		]);
	});

	it("reds a private @kampus dep pinned to a version", () => {
		const v = judge([
			manifest("packages/demo-cli/package.json", "@kampus/demo-cli", [
				{field: "dependencies", name: "@kampus/leak-guard", value: "^1.0.0"},
			]),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations[0]?.kind).toBe("private-kampus-dep");
	});

	it("scans optionalDependencies and peerDependencies, not just dependencies", () => {
		const v = judge([
			manifest("packages/demo-cli/package.json", "@kampus/demo-cli", [
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

	// A published sibling resolves from the registry, so it is not a violation.
	it("passes a @kampus dep that is ITSELF in the published set", () => {
		const v = judge([
			manifest("packages/demo-cli/package.json", "@kampus/demo-cli", [
				{field: "dependencies", name: "@kampus/fabrika-cli", value: "^0.1.0"},
			]),
			manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", [
				{field: "dependencies", name: "effect", value: "catalog:"},
			]),
		]);
		expect(v.pass).toBe(true);
	});

	it("passes a workspace: link whose target is ITSELF in the published set", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "dependencies", name: "@kampus/design", value: "workspace:*"},
				{field: "peerDependencies", name: "@kampus/demo-sdk", value: "workspace:*"},
			]),
			manifest("packages/design/package.json", "@kampus/design", []),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		expect(v.pass).toBe(true);
	});

	it("reds a workspace: link to a package outside the published set, beside a published one", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "peerDependencies", name: "@kampus/demo-sdk", value: "workspace:*"},
				{field: "dependencies", name: "@kampus/epic-ledger", value: "workspace:^"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations).toEqual([
			{
				path: "packages/demo-ui/package.json",
				field: "dependencies",
				name: "@kampus/epic-ledger",
				value: "workspace:^",
				kind: "workspace-link",
			},
		]);
	});

	it("judges an aliased workspace: link by the package it names, not the alias", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "dependencies", name: "@kampus/demo-sdk", value: "workspace:@kampus/epic-ledger@*"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations[0]?.kind).toBe("workspace-link");
	});

	it("reds a path-form workspace: link even when the dep name is a published sibling", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "dependencies", name: "@kampus/demo-sdk", value: "workspace:../epic-ledger"},
				{field: "peerDependencies", name: "@kampus/demo-sdk", value: "workspace:./vendor/private"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations).toEqual([
			{
				path: "packages/demo-ui/package.json",
				field: "dependencies",
				name: "@kampus/demo-sdk",
				value: "workspace:../epic-ledger",
				kind: "workspace-path-link",
			},
			{
				path: "packages/demo-ui/package.json",
				field: "peerDependencies",
				name: "@kampus/demo-sdk",
				value: "workspace:./vendor/private",
				kind: "workspace-path-link",
			},
		]);
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
				"=~ ^fabrika-cli-v([0-9].*)$ ... =~ ^demo-cli-v([0-9].*)$ ... =~ ^demo-cli-v(.*)$",
			),
		).toEqual(["demo-cli", "fabrika-cli"]);
	});
});

describe("resolvePublished", () => {
	const members: ReadonlyArray<PublishedManifest> = [
		manifest("packages/demo-cli/package.json", "@kampus/demo-cli", []),
		manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", []),
		manifest("apps/site/package.json", "@kampus/site", []),
	];

	it("resolves a prefix to the member whose unscoped name matches", () => {
		const {published, unmatchedPrefixes} = resolvePublished(["demo-cli"], members);
		expect(published.map((m) => m.name)).toEqual(["@kampus/demo-cli"]);
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

describe("workspaceLink", () => {
	const dep = (value: string) => ({field: "dependencies", name: "@kampus/demo-sdk", value});
	it("names the dependency itself for a plain workspace: range", () => {
		expect(workspaceLink(dep("workspace:*"))).toEqual({kind: "package", name: "@kampus/demo-sdk"});
		expect(workspaceLink(dep("workspace:^0.1.0"))).toEqual({
			kind: "package",
			name: "@kampus/demo-sdk",
		});
	});
	it("names the aliased package for workspace:<name>@<range>", () => {
		expect(workspaceLink(dep("workspace:@kampus/design@*"))).toEqual({
			kind: "package",
			name: "@kampus/design",
		});
		expect(workspaceLink(dep("workspace:effect@^3"))).toEqual({kind: "package", name: "effect"});
	});
	it("reads a path-form specifier as a path, never as the dep's own name", () => {
		expect(workspaceLink(dep("workspace:../epic-ledger"))).toEqual({
			kind: "path",
			path: "../epic-ledger",
		});
		expect(workspaceLink(dep("workspace:./vendor/private"))).toEqual({
			kind: "path",
			path: "./vendor/private",
		});
		expect(workspaceLink(dep("workspace:/abs/pkg"))).toEqual({kind: "path", path: "/abs/pkg"});
	});
	it("answers undefined for a specifier that is not a workspace link", () => {
		expect(workspaceLink(dep("catalog:"))).toBeUndefined();
		expect(workspaceLink(dep("^1.0.0"))).toBeUndefined();
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
