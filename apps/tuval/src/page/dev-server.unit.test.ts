/**
 * The two generated modules, as text: the page server writes the loader module from the rows'
 * `kind: "module"` references (ADR 0359) and the feature-flag module from the booted config (#8439),
 * and this is the one place either shape is pinned. The served loader module and the boot-time
 * refusal of a specifier that does not resolve are `module-renderers.integration.test.ts`.
 */

import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {loadLayeredConfig} from "../config.ts";
import type {AnyProgram} from "../registry/program.ts";
import {counterRow, noRendererRow} from "../shell/window/fixtures.ts";
import {type DeclaredProgram, moduleRendererRefs} from "../shell/window/index.ts";
import {
	featuresSource,
	moduleRenderersSource,
	optimizedDepEntries,
	servedDirectories,
} from "./dev-server.ts";

const GLOBAL_CONFIG = "/home/founder/.tuval/tuval.config.ts";
const PROJECT_CONFIG = "/work/app/.tuval/tuval.config.ts";

describe("the module renderers loader module", () => {
	it("holds one static import() per reference, keyed by the reference the row wrote", () => {
		expect(
			moduleRenderersSource(["@csirin/tuval-calc/window", "/src/demo/module-window.tsx"]),
		).toBe(`export default {
\t"@csirin/tuval-calc/window": () => import("@csirin/tuval-calc/window"),
\t"/src/demo/module-window.tsx": () => import("/src/demo/module-window.tsx"),
};
`);
	});

	it("is an empty record when no row names a module, so the page loads nothing", () => {
		expect(moduleRenderersSource([])).toBe("export default {\n\n};\n");
	});

	it("writes a specifier as a string literal, whatever it holds", () => {
		expect(moduleRenderersSource(['a"b'])).toContain('import("a\\"b")');
	});

	it("escapes the two line terminators JSON leaves raw, so a specifier cannot end a line of code", () => {
		const source = moduleRenderersSource(["a\u2028b\u2029c"]);
		expect(source).not.toMatch(/[\u2028\u2029]/);
		expect(source).toContain('import("a\\u2028b\\u2029c")');
	});
});

/**
 * Driven from real merged configs rather than a hand-written flag record, because the wire this
 * pins is the whole one: what a founder writes in a layer is what the browser reads. A merge that
 * resolved a flag differently would show up here as generated source, which is the failure #8439
 * was — the flag merged correctly and reached nobody.
 */
describe("the feature-flag module", () => {
	const fixture = (name: string) =>
		fileURLToPath(new URL(`../config-fixtures/${name}.ts`, import.meta.url));

	const generated = (global: string, project: string) =>
		Effect.runPromise(
			loadLayeredConfig({global: fixture(global), project: fixture(project)}).pipe(
				Effect.map((config) => featuresSource(config.features)),
				Effect.provide(NodeFileSystem.layer),
			),
		);

	it("carries a flag a layer turned on", async () => {
		expect(await generated("features-on", "two-rows")).toBe(
			'export default {\n\t"subagentList": true,\n};\n',
		);
	});

	it("carries a flag a layer turned off", async () => {
		expect(await generated("features-off", "two-rows")).toBe(
			'export default {\n\t"subagentList": false,\n};\n',
		);
	});

	// The page reads `features.subagentList` and gets a boolean either way: an absent key would read
	// `undefined`, which is falsy and so passes by luck until a flag defaults on.
	it("carries every flag as false when no layer declares a features block", async () => {
		expect(await generated("two-rows", "one-counter")).toBe(
			'export default {\n\t"subagentList": false,\n};\n',
		);
	});

	it("names no flag itself, so a flag added to TuvalFeatures crosses with no edit here", () => {
		expect(featuresSource({subagentList: true, somethingLater: false} as never)).toBe(
			'export default {\n\t"subagentList": true,\n\t"somethingLater": false,\n};\n',
		);
	});
});

describe("moduleRendererRefs", () => {
	const declared = (row: AnyProgram, origin: string): DeclaredProgram => ({row, origin});

	it("lists the module references only, each once, in row order, each with its own config", () => {
		const module = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		const again = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		const other = {...counterRow, renderer: {kind: "module", ref: "@x/two/window"}} as const;
		expect(
			moduleRendererRefs([
				declared(counterRow, GLOBAL_CONFIG),
				declared(noRendererRow, GLOBAL_CONFIG),
				declared(other, GLOBAL_CONFIG),
				declared(module, PROJECT_CONFIG),
				declared(again, PROJECT_CONFIG),
			]),
		).toEqual([
			{ref: "@x/two/window", origin: GLOBAL_CONFIG},
			{ref: "@x/one/window", origin: PROJECT_CONFIG},
		]);
	});

	it("keeps the first row's config when two rows write one specifier, as the table has one seat", () => {
		const first = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		const second = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		expect(
			moduleRendererRefs([declared(first, GLOBAL_CONFIG), declared(second, PROJECT_CONFIG)]),
		).toEqual([{ref: "@x/one/window", origin: GLOBAL_CONFIG}]);
	});
});

describe("what a resolved reference tells the page server", () => {
	const installed = {
		ref: "@acme/win/window",
		origin: GLOBAL_CONFIG,
		file: "/home/founder/.tuval/node_modules/@acme/win/window.js",
	};
	const inTree = {
		ref: "/src/demo/module-window.tsx",
		origin: PROJECT_CONFIG,
		file: "/work/app/apps/tuval/src/demo/module-window.tsx",
	};

	it("optimises the file behind a bare specifier, not the specifier the app root cannot resolve", () => {
		expect(optimizedDepEntries([installed, inTree])).toEqual([installed.file]);
	});

	it("leaves an in-tree path to the optimiser's source handling, as it always was", () => {
		expect(optimizedDepEntries([inTree])).toEqual([]);
	});

	it("asks the file server for the config's directory and the module's, and each once", () => {
		expect(servedDirectories([installed, installed, inTree])).toEqual([
			"/home/founder/.tuval",
			"/home/founder/.tuval/node_modules/@acme/win",
		]);
	});
});
