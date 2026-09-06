/**
 * The generated loader module (ADR 0359), as text: the page server writes it from the rows'
 * `kind: "module"` references, and this is the one place its shape is pinned. The served module and
 * the boot-time refusal of a specifier that does not resolve are `module-renderers.integration.test.ts`.
 */

import {describe, expect, it} from "vitest";
import {counterRow, noRendererRow} from "../shell/window/fixtures.ts";
import {moduleRendererRefs} from "../shell/window/index.ts";
import {moduleRenderersSource} from "./dev-server.ts";

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

describe("moduleRendererRefs", () => {
	it("lists the module references only, each once, in row order", () => {
		const module = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		const again = {...counterRow, renderer: {kind: "module", ref: "@x/one/window"}} as const;
		const other = {...counterRow, renderer: {kind: "module", ref: "@x/two/window"}} as const;
		expect(moduleRendererRefs([counterRow, noRendererRow, other, module, again])).toEqual([
			"@x/two/window",
			"@x/one/window",
		]);
	});
});
