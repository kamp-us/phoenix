import {describe, expect, it, vi} from "vitest";
import {
	type ContributionModuleTransport,
	ContributionRegistry,
} from "../../src/frontend-shell/contribution-registry.js";

const entry = (
	packageName: string,
	kind: "node" | "edge" | "panel",
	key: string,
	asset: string,
) => ({
	packageName,
	kind,
	key,
	asset,
});

const catalog = (
	frontend: ReadonlyArray<ReturnType<typeof entry>>,
	diagnostics: ReadonlyArray<Record<string, unknown>> = [],
) => ({
	contractVersion: 1,
	frontend,
	diagnostics,
});

const moduleFor = (kind: "node" | "edge" | "panel", version = 1) => ({
	default: {contractVersion: version, kind, render: () => null},
});

const transport = (
	modules: Readonly<Record<string, unknown>>,
	contentTypes: Readonly<Record<string, string>> = {},
): ContributionModuleTransport => ({
	read: vi.fn(async (asset) => ({
		ok: Object.hasOwn(modules, asset),
		contentType: contentTypes[asset] ?? "text/javascript; charset=utf-8",
	})),
	importModule: vi.fn(async (asset) => {
		if (!Object.hasOwn(modules, asset)) throw new Error("missing");
		const value = modules[asset];
		if (value instanceof Error) throw value;
		return value;
	}),
});

describe("ContributionRegistry", () => {
	it("rejects catalog entries and diagnostics outside the closed versioned shape", async () => {
		const asset = "/api/contribution-assets/v1-0.js";
		const malformedCatalogs: ReadonlyArray<unknown> = [
			{
				contractVersion: 1,
				frontend: [{...entry("fixture-package", "node", "fixture.node", asset), extra: true}],
				diagnostics: [],
			},
			{
				contractVersion: 1,
				frontend: [{...entry("fixture-package", "node", "fixture.node", asset), kind: "widget"}],
				diagnostics: [],
			},
			{
				contractVersion: 1,
				frontend: [],
				diagnostics: [
					{
						packageName: "fixture-package",
						reason: "manifest-invalid",
						message: "unsupported fixture",
						extra: true,
					},
				],
			},
		];
		for (const value of malformedCatalogs) {
			const registry = await ContributionRegistry.load(
				value,
				ContributionRegistry.empty(),
				transport({[asset]: moduleFor("node")}),
			);
			expect(registry.loaded).toEqual([]);
			expect(registry.diagnostics.map(({code}) => code)).toEqual(["catalog-invalid"]);
		}
	});

	it("registers contract-compatible node, edge, and panel modules with package attribution", async () => {
		const registry = await ContributionRegistry.load(
			catalog([
				entry("fixture-package", "node", "fixture.node", "/api/contribution-assets/v1-0.js"),
				entry("fixture-package", "edge", "fixture.edge", "/api/contribution-assets/v1-1.js"),
				entry("fixture-package", "panel", "fixture.panel", "/api/contribution-assets/v1-2.js"),
			]),
			ContributionRegistry.empty(),
			transport({
				"/api/contribution-assets/v1-0.js": moduleFor("node"),
				"/api/contribution-assets/v1-1.js": moduleFor("edge"),
				"/api/contribution-assets/v1-2.js": moduleFor("panel"),
			}),
		);
		expect([...registry.nodes]).toHaveLength(1);
		expect([...registry.edges]).toHaveLength(1);
		expect([...registry.panels]).toHaveLength(1);
		expect(registry.loaded.every(({packageName}) => packageName === "fixture-package")).toBe(true);
		expect(registry.diagnostics).toEqual([]);
	});

	it.each([
		["unsupported module version", moduleFor("node", 2), "text/javascript", "unsupported-version"],
		[
			"closed export violation",
			{extra: true, default: moduleFor("node").default},
			"text/javascript",
			"module-invalid",
		],
		["HTML response", moduleFor("node"), "text/html; charset=utf-8", "asset-not-javascript"],
		["module load failure", new Error("syntax error"), "text/javascript", "module-load-failed"],
	] as const)("fails a package closed on %s", async (_name, module, contentType, code) => {
		const asset = "/api/contribution-assets/v1-0.js";
		const registry = await ContributionRegistry.load(
			catalog([
				entry("broken-package", "node", "broken.node", asset),
				entry("broken-package", "panel", "broken.panel", "/api/contribution-assets/v1-1.js"),
			]),
			ContributionRegistry.empty(),
			transport(
				{[asset]: module, "/api/contribution-assets/v1-1.js": moduleFor("panel")},
				{[asset]: contentType},
			),
		);
		expect(registry.loaded).toEqual([]);
		expect(registry.diagnostics.map(({code: value}) => value)).toContain(code);
	});

	it("keeps built-in keys unoverrideable and isolates duplicate package keys", async () => {
		const modules = {
			"/api/contribution-assets/v1-0.js": moduleFor("node"),
			"/api/contribution-assets/v1-1.js": moduleFor("node"),
			"/api/contribution-assets/v1-2.js": moduleFor("node"),
		};
		const registry = await ContributionRegistry.load(
			catalog([
				entry("override-package", "node", "session", "/api/contribution-assets/v1-0.js"),
				entry("healthy-package", "node", "healthy.node", "/api/contribution-assets/v1-1.js"),
				entry("duplicate-package", "node", "healthy.node", "/api/contribution-assets/v1-2.js"),
			]),
			ContributionRegistry.empty(),
			transport(modules),
		);
		expect([...registry.nodes.keys()]).toEqual(["healthy.node"]);
		expect(registry.diagnostics.map(({code}) => code)).toEqual(["built-in-key", "duplicate-key"]);
	});

	it("surfaces missing assets, backend diagnostics, and unload without retaining stale renderers", async () => {
		const asset = "/api/contribution-assets/v1-0.js";
		const first = await ContributionRegistry.load(
			catalog([entry("fixture-package", "node", "fixture.node", asset)]),
			ContributionRegistry.empty(),
			transport({[asset]: moduleFor("node")}),
		);
		const missing = await ContributionRegistry.load(
			catalog(
				[entry("missing-package", "node", "missing.node", asset)],
				[
					{
						packageName: "manifest-package",
						reason: "manifest-invalid",
						message: "unsupported fixture",
					},
				],
			),
			first,
			transport({}),
		);
		expect(missing.loaded).toEqual([]);
		expect(missing.diagnostics.map(({packageName, code}) => ({packageName, code}))).toEqual([
			{packageName: "manifest-package", code: "unsupported-version"},
			{packageName: "fixture-package", code: "unloaded"},
			{packageName: "missing-package", code: "asset-unavailable"},
		]);
	});
});
