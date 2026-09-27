import {describe, expect, it} from "vitest";
import {
	bundledEdges,
	composeManifest,
	type Manifest,
	packageOf,
	pageExternal,
	readFrom,
	renderComposed,
	serverExternal,
} from "./manifest.ts";

describe("the package a specifier imports", () => {
	it("names a bare package, scoped or not, whatever subpath it reaches", () => {
		expect(packageOf("effect")).toBe("effect");
		expect(packageOf("effect/unstable/cli")).toBe("effect");
		expect(packageOf("@kampus/tuval-sdk/kernel/process/process")).toBe("@kampus/tuval-sdk");
		expect(packageOf("react-dom/client")).toBe("react-dom");
	});

	it("names nothing for a path, a builtin, a generated module or a bundler-internal id", () => {
		for (const specifier of [
			"./boot.ts",
			"../x.ts",
			"/src/page/main.tsx",
			"node:fs",
			"virtual:tuval/features",
			"\0virtual:tuval/features",
			"@kampus",
			"",
		]) {
			expect(packageOf(specifier), specifier).toBeNull();
		}
	});
});

describe("what each bundle leaves as an import", () => {
	it("leaves the page's shared packages and generated modules out, and carries the rest", () => {
		expect(pageExternal("react")).toBe(true);
		expect(pageExternal("react/jsx-runtime")).toBe(true);
		expect(pageExternal("effect/unstable/socket")).toBe(true);
		expect(pageExternal("@kampus/tuval-sdk/kernel/shell/window/host")).toBe(true);
		expect(pageExternal("virtual:tuval/module-renderers")).toBe(true);
		expect(pageExternal("@kampus/tuval-ui/desk")).toBe(false);
		expect(pageExternal("@manti-ui/react")).toBe(false);
		expect(pageExternal("./boot.tsx")).toBe(false);
	});

	it("leaves every package out of the server but the workspace ones it carries", () => {
		const external = serverExternal(new Set(["@kampus/tuval-ui"]));
		expect(external("@kampus/tuval-ui/keys")).toBe(false);
		expect(external("./config.ts")).toBe(false);
		expect(external("node:path")).toBe(false);
		expect(external("@kampus/tuval-sdk/config")).toBe(true);
		expect(external("vite")).toBe(true);
	});
});

describe("the workspace packages the desk carries", () => {
	it("follows workspace dependencies, and never the SDK or a published one", () => {
		const app: Manifest = {
			name: "@kampus-apps/tuval",
			version: "0.0.0",
			dependencies: {
				"@kampus/tuval-sdk": "workspace:*",
				"@kampus/tuval-ui": "workspace:*",
				effect: "catalog:",
			},
			devDependencies: {"@kampus/design": "workspace:*"},
		};
		expect(bundledEdges(app)).toEqual(["@kampus/tuval-ui"]);
	});
});

describe("finding a bundled SDK copy", () => {
	it("names the modules read from inside the SDK's directory, and nothing beside it", () => {
		const ids = [
			"/repo/packages/tuval/src/config.ts",
			"/repo/packages/tuval-ui/src/keys.ts",
			"/repo/packages/tuval/src/config.ts",
		];
		expect(readFrom(ids, "/repo/packages/tuval")).toEqual(["/repo/packages/tuval/src/config.ts"]);
		expect(readFrom(ids.slice(1, 2), "/repo/packages/tuval")).toEqual([]);
	});
});

describe("the packed manifest", () => {
	const app: Manifest = {
		name: "@kampus-apps/tuval",
		version: "0.3.0",
		description: "the desk",
		license: "MIT",
		dependencies: {
			"@kampus/tuval-sdk": "workspace:*",
			"@kampus/tuval-ui": "workspace:*",
			effect: "catalog:",
		},
		devDependencies: {vite: "catalog:"},
	};
	const ui: Manifest = {
		name: "@kampus/tuval-ui",
		version: "0.0.0",
		dependencies: {"@tanstack/react-virtual": "catalog:"},
		peerDependencies: {react: "catalog:"},
	};

	it("packs as @kampus/tuval with the tuval bin, an exports map of no source, and the SDK as a dependency", () => {
		const composed = composeManifest({
			app,
			bundled: [ui],
			imports: ["vite", "effect", "@kampus/tuval-sdk", "react", "effect"],
		});
		expect(composed).toEqual({
			_tag: "Composed",
			manifest: {
				name: "@kampus/tuval",
				version: "0.3.0",
				description: "the desk",
				license: "MIT",
				type: "module",
				bin: {tuval: "./server/bin.js"},
				exports: {"./package.json": "./package.json"},
				dependencies: {
					"@effect/platform-node-shared": "catalog:",
					"@kampus/tuval-sdk": "workspace:*",
					effect: "catalog:",
					react: "catalog:",
					vite: "catalog:",
				},
			},
		});
	});

	it("refuses an import no manifest behind the desk declares", () => {
		const composed = composeManifest({app, bundled: [ui], imports: ["effect", "left-pad"]});
		expect(composed).toEqual({_tag: "Undeclared", packages: ["left-pad"]});
		if (composed._tag !== "Composed") expect(renderComposed(composed)).toContain("left-pad");
	});

	it("refuses a workspace package the bundles import instead of carrying", () => {
		const composed = composeManifest({app, bundled: [ui], imports: ["@kampus/tuval-ui"]});
		expect(composed).toEqual({_tag: "Unbundled", packages: ["@kampus/tuval-ui"]});
	});
});
