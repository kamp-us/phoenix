/**
 * The pure rule behind `guard publish-isolation-guard check`, ported from the v1 CLI's
 * `publish-isolation-guard.unit.test.ts`: the verdict over already-gathered
 * facts, plus the two derivation helpers — parsing publish.yml's resolve arms, and mapping arms
 * onto members. No disk; the IO seam is covered in `publish-isolation-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	depTarget,
	judge,
	manifestRuntimeDeps,
	type PublishedManifest,
	parsePublishArms,
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

	// pnpm publish rewrites only `workspace:` and `catalog:`, so these ship as a local path.
	it("reds a link:, file: or portal: dep even when its name is a published sibling", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "dependencies", name: "@kampus/demo-sdk", value: "link:../demo-sdk"},
				{field: "optionalDependencies", name: "vendored", value: "file:../../vendor/x.tgz"},
				{field: "peerDependencies", name: "@kampus/demo-sdk", value: "portal:../demo-sdk"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations.map((x) => x.kind)).toEqual([
			"local-path-link",
			"local-path-link",
			"local-path-link",
		]);
	});

	it("judges an npm: alias by the package it fetches, not the alias", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "dependencies", name: "ledger", value: "npm:@kampus/epic-ledger@^1.0.0"},
				{field: "dependencies", name: "sdk", value: "npm:@kampus/demo-sdk@^0.1.0"},
				{field: "dependencies", name: "@kampus/epic-ledger", value: "npm:left-pad@^1.0.0"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations).toEqual([
			{
				path: "packages/demo-ui/package.json",
				field: "dependencies",
				name: "ledger",
				value: "npm:@kampus/epic-ledger@^1.0.0",
				kind: "private-kampus-dep",
			},
		]);
	});

	it("reds a range that embeds workspace: when the dep is not published, whatever its scope", () => {
		const v = judge([
			manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
				{field: "peerDependencies", name: "internal-lib", value: "^1.0.0 || workspace:*"},
				{field: "peerDependencies", name: "@kampus/demo-sdk", value: "^0.1.0 || workspace:*"},
			]),
			manifest("packages/demo-sdk/package.json", "@kampus/demo-sdk", []),
		]);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations.map((x) => [x.name, x.kind])).toEqual([["internal-lib", "workspace-link"]]);
	});

	it("fails closed when no published packages are in scope", () => {
		const v = judge([]);
		if (v.pass) throw new Error("expected a failure");
		expect(v.reason).toBe("zero-scope");
	});
});

describe("parsePublishArms", () => {
	it("pairs each `^<prefix>-v(...)` anchor with the PKG_DIR it sets", () => {
		expect(
			parsePublishArms(
				[
					'if [[ "$TAG" =~ ^fabrika-cli-v([0-9].*)$ ]]; then',
					'  PKG_DIR="packages/fabrika-cli"',
					'elif [[ "$TAG" =~ ^demo-sdk-v([0-9].*)$ ]]; then',
					'  PKG_DIR="packages/sdk-core"',
					"fi",
					'echo "PKG_DIR=$PKG_DIR"',
				].join("\n"),
			),
		).toEqual([
			{prefix: "fabrika-cli", dir: "packages/fabrika-cli"},
			{prefix: "demo-sdk", dir: "packages/sdk-core"},
		]);
	});

	it("ignores a bare `<name>-v<version>` prose mention — no ^ anchor, no capture group", () => {
		expect(
			parsePublishArms(
				"# Release tag grammar: `fabrika-cli-v<version>` (e.g. `fabrika-cli-v0.1.0`)",
			),
		).toEqual([]);
	});

	// A PKG_DIR after the next anchor belongs to that arm, never to this one.
	it("answers a null dir for an anchor that sets no PKG_DIR before the next anchor", () => {
		expect(
			parsePublishArms(
				'=~ ^demo-cli-v(.*)$ ... =~ ^fabrika-cli-v(.*)$ PKG_DIR="packages/fabrika-cli"',
			),
		).toEqual([
			{prefix: "demo-cli", dir: null},
			{prefix: "fabrika-cli", dir: "packages/fabrika-cli"},
		]);
	});
});

describe("resolvePublished", () => {
	const members: ReadonlyArray<PublishedManifest> = [
		manifest("packages/demo-cli/package.json", "@kampus/demo-cli", []),
		manifest("packages/fabrika-cli/package.json", "@kampus/fabrika-cli", []),
		manifest("packages/sdk-core/package.json", "@kampus/demo-sdk", []),
		manifest("apps/site/package.json", "@kampus/site", []),
	];

	it("resolves each arm to the member at its PKG_DIR, whatever the directory is called", () => {
		const {published, drift} = resolvePublished(
			[
				{prefix: "demo-cli", dir: "packages/demo-cli"},
				{prefix: "demo-sdk", dir: "packages/sdk-core"},
			],
			members,
		);
		expect(published.map((m) => m.name)).toEqual(["@kampus/demo-cli", "@kampus/demo-sdk"]);
		expect(drift).toEqual([]);
	});

	// The set is what the arms publish, not every member sharing a name.
	it("leaves a member that only shares the unscoped name out of the published set", () => {
		const {published, drift} = resolvePublished(
			[{prefix: "demo-sdk", dir: "packages/sdk-core"}],
			[...members, manifest("apps/x/package.json", "@other/demo-sdk", [])],
		);
		expect(published.map((m) => m.path)).toEqual(["packages/sdk-core/package.json"]);
		expect(drift).toEqual([]);
	});

	it("reds a link to the colliding member, end to end through the derived set", () => {
		const ui = manifest("packages/demo-ui/package.json", "@kampus/demo-ui", [
			{field: "dependencies", name: "@other/demo-sdk", value: "workspace:*"},
		]);
		const {published} = resolvePublished(
			[
				{prefix: "demo-sdk", dir: "packages/sdk-core"},
				{prefix: "demo-ui", dir: "packages/demo-ui"},
			],
			[...members, ui, manifest("apps/x/package.json", "@other/demo-sdk", [])],
		);
		const v = judge(published);
		if (v.pass || v.reason !== "linked-private-deps") throw new Error("expected a violation");
		expect(v.violations.map((x) => [x.name, x.kind])).toEqual([
			["@other/demo-sdk", "workspace-link"],
		]);
	});

	it("surfaces a PKG_DIR with no member there as drift", () => {
		const {published, drift} = resolvePublished(
			[{prefix: "does-not-exist", dir: "packages/does-not-exist"}],
			members,
		);
		expect(published).toEqual([]);
		expect(drift).toEqual([
			{reason: "no-member", prefix: "does-not-exist", dir: "packages/does-not-exist"},
		]);
	});

	it("surfaces an arm with no PKG_DIR, and a prefix split across directories, as drift", () => {
		const {published, drift} = resolvePublished(
			[
				{prefix: "demo-cli", dir: null},
				{prefix: "fabrika-cli", dir: "packages/fabrika-cli"},
				{prefix: "fabrika-cli", dir: "packages/demo-cli"},
			],
			members,
		);
		expect(published).toEqual([]);
		expect(drift).toEqual([
			{reason: "no-directory", prefix: "demo-cli"},
			{
				reason: "several-directories",
				prefix: "fabrika-cli",
				dirs: ["packages/demo-cli", "packages/fabrika-cli"],
			},
		]);
	});

	it("tolerates a repeated anchor that sets no PKG_DIR beside one that does", () => {
		const {published, drift} = resolvePublished(
			[
				{prefix: "demo-cli", dir: null},
				{prefix: "demo-cli", dir: "packages/demo-cli"},
			],
			members,
		);
		expect(published.map((m) => m.name)).toEqual(["@kampus/demo-cli"]);
		expect(drift).toEqual([]);
	});

	it("surfaces a member whose name does not match the tag prefix as drift", () => {
		const {published, drift} = resolvePublished(
			[{prefix: "demo-cli", dir: "packages/fabrika-cli"}],
			members,
		);
		expect(published).toEqual([]);
		expect(drift).toEqual([
			{
				reason: "name-mismatch",
				prefix: "demo-cli",
				dir: "packages/fabrika-cli",
				name: "@kampus/fabrika-cli",
			},
		]);
	});

	// pnpm resolves `workspace:` by name and takes the highest matching version.
	it("surfaces a published name another member also carries as drift", () => {
		const {published, drift} = resolvePublished(
			[{prefix: "demo-sdk", dir: "packages/sdk-core"}],
			[...members, manifest("apps/x/package.json", "@kampus/demo-sdk", [])],
		);
		expect(published).toEqual([]);
		expect(drift).toEqual([
			{
				reason: "name-shared",
				prefix: "demo-sdk",
				dir: "packages/sdk-core",
				name: "@kampus/demo-sdk",
				others: ["apps/x"],
			},
		]);
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

describe("depTarget", () => {
	const dep = (value: string) => ({field: "dependencies", name: "@kampus/demo-sdk", value});
	const pkg = (name: string) => ({kind: "workspace-package", name});
	it("names the dependency itself for a plain workspace: range", () => {
		expect(depTarget(dep("workspace:*"))).toEqual(pkg("@kampus/demo-sdk"));
		expect(depTarget(dep("workspace:^0.1.0"))).toEqual(pkg("@kampus/demo-sdk"));
	});
	it("names the aliased package for workspace:<name>@<range>", () => {
		expect(depTarget(dep("workspace:@kampus/design@*"))).toEqual(pkg("@kampus/design"));
		expect(depTarget(dep("workspace:effect@^3"))).toEqual(pkg("effect"));
	});
	it("reads a range that embeds workspace: as a link by the dep's own name", () => {
		expect(depTarget(dep("^0.1.0 || workspace:*"))).toEqual(pkg("@kampus/demo-sdk"));
	});
	it("reads a path-form specifier as a path, never as the dep's own name", () => {
		expect(depTarget(dep("workspace:../epic-ledger"))).toEqual({
			kind: "workspace-path",
			path: "../epic-ledger",
		});
		expect(depTarget(dep("workspace:./vendor/private"))).toEqual({
			kind: "workspace-path",
			path: "./vendor/private",
		});
		expect(depTarget(dep("workspace:/abs/pkg"))).toEqual({
			kind: "workspace-path",
			path: "/abs/pkg",
		});
	});
	it("reads link:, file: and portal: as a local path", () => {
		for (const spec of ["link:../x", "file:../x.tgz", "portal:../x"]) {
			expect(depTarget(dep(spec))).toEqual({kind: "local-path", spec});
		}
	});
	it("names an npm: alias by its target, with or without a range", () => {
		expect(depTarget(dep("npm:@kampus/epic-ledger@^1"))).toEqual({
			kind: "registry",
			name: "@kampus/epic-ledger",
		});
		expect(depTarget(dep("npm:@kampus/epic-ledger"))).toEqual({
			kind: "registry",
			name: "@kampus/epic-ledger",
		});
		expect(depTarget(dep("npm:left-pad@1"))).toEqual({kind: "registry", name: "left-pad"});
	});
	it("names the dependency itself for a registry range or catalog: entry", () => {
		expect(depTarget(dep("catalog:"))).toEqual({kind: "registry", name: "@kampus/demo-sdk"});
		expect(depTarget(dep("^1.0.0"))).toEqual({kind: "registry", name: "@kampus/demo-sdk"});
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
