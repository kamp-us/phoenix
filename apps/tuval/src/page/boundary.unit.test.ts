/**
 * The page is Node-free, proven by walking the runtime import graph of every module a browser
 * loads. Vite externalizes a `node:` module in client code and the first property read throws at
 * load, so a kernel-side layer placed beside a tag the page reaches blanks the whole desk with
 * green CI behind it (#7910: `Processes` reached `src/shell/commands/dispatch.ts` through
 * `shell/ui/CommandLine.tsx`). Walking the graph from each entry names the offending chain rather
 * than the symptom.
 *
 * **There are two classes of entry, and this walk covers both (#8946).** The first is
 * `./main.tsx`, the page's own bundle. The second arrived with ADR 0359: a `kind: "module"`
 * renderer, which the page resolves from a specifier at runtime and imports as a module of its own.
 * A window module is the entry an author writes, and it is the one that met this hazard in a
 * browser rather than in CI — it imported its own program's file for a state type, and an authored
 * program's file reaches `node:crypto` through `../authoring/define-program.ts`.
 *
 * In-tree module windows are found rather than listed: a root-relative specifier (`/src/…`) is how
 * a module in this tree is named to the page and is a spelling nothing else uses, so scanning the
 * source for one finds every window a row can declare without this file holding a register that a
 * new window's author has to remember to edit. A module a *package* ships is out of this walk's
 * reach and carries its own guard beside its own source
 * (`packages/tuval-notify/src/state.unit.test.ts`).
 *
 * Only runtime edges count: an `import type` is erased by the bundler and reaches nothing.
 */

import {existsSync, readdirSync, readFileSync} from "node:fs";
import {builtinModules} from "node:module";
import {dirname, join, relative, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const APP_ROOT = resolve(SRC, "..");
const PAGE_ENTRY = resolve(import.meta.dirname, "main.tsx");
const BUILTINS = new Set(builtinModules);

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every runtime specifier a module imports: `import x from`, `import "side-effect"`, `export … from`. */
const specifiersOf = (file: string): ReadonlyArray<string> => {
	const code = stripComments(readFileSync(file, "utf8"));
	const found: Array<string> = [];
	for (const match of code.matchAll(/^\s*(import|export)\s+([\s\S]*?)from\s+["']([^"']+)["']/gm)) {
		if (/^type\s/.test(match[2] ?? "")) continue;
		found.push(match[3] as string);
	}
	for (const match of code.matchAll(/^\s*import\s+["']([^"']+)["']/gm))
		found.push(match[1] as string);
	return found;
};

const resolveRelative = (from: string, specifier: string): string | undefined => {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (existsSync(candidate) && !candidate.endsWith(".css")) return candidate;
	}
	return undefined;
};

const isNodeOnly = (specifier: string): boolean =>
	specifier.startsWith("node:") || BUILTINS.has(specifier);

const sourceFiles = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});

/**
 * Every module in this tree a row can name as a `kind: "module"` renderer, read off the source
 * rather than off a list: the specifier is a path from the page root, so it resolves against the
 * app root and names a file that has to exist.
 */
const moduleWindowEntries = (): ReadonlyArray<string> => {
	const found = new Set<string>();
	for (const file of sourceFiles(SRC)) {
		const code = stripComments(readFileSync(file, "utf8"));
		for (const match of code.matchAll(/["'](\/src\/[^"']+\.tsx?)["']/g)) {
			const candidate = resolve(APP_ROOT, `.${match[1] as string}`);
			if (existsSync(candidate)) found.add(candidate);
		}
	}
	return [...found];
};

/** Depth-first over relative imports, recording each `node:` edge with the chain that reached it. */
const walk = (
	entries: ReadonlyArray<string>,
): {
	readonly modules: ReadonlyArray<string>;
	readonly leaks: ReadonlyArray<string>;
} => {
	const seen = new Set<string>();
	const leaks: Array<string> = [];
	const visit = (file: string, chain: ReadonlyArray<string>): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const here = [...chain, relative(SRC, file)];
		for (const specifier of specifiersOf(file)) {
			if (isNodeOnly(specifier)) {
				leaks.push(`${here.join(" -> ")} -> ${specifier}`);
				continue;
			}
			if (!specifier.startsWith(".")) continue;
			const next = resolveRelative(file, specifier);
			if (next !== undefined) visit(next, here);
		}
	};
	for (const entry of entries) visit(entry, []);
	return {modules: [...seen].map((file) => relative(SRC, file)), leaks};
};

describe("the page's import graph", () => {
	const windows = moduleWindowEntries();
	const graph = walk([PAGE_ENTRY, ...windows]);

	it("reaches the shell, so the walk is not vacuous", () => {
		expect(graph.modules.length).toBeGreaterThan(20);
		expect(graph.modules).toEqual(
			expect.arrayContaining(["shell/commands/index.ts", "shell/commands/dispatch.ts"]),
		);
	});

	it("covers the module windows this tree declares, not only the page's own entry", () => {
		// The in-tree window, found by its own root-relative specifier. A walk that found nothing
		// would pass the leak test below by never opening a second entry at all.
		expect(windows.map((file) => relative(SRC, file))).toContain("demo/module-window.tsx");
		expect(graph.modules).toContain("demo/module-window.tsx");
	});

	it("never reaches a Node-only module", () => {
		expect(graph.leaks).toEqual([]);
	});

	it("reads runtime edges only: an import type is not an edge", () => {
		// `shell/commands/dispatch.ts` is in the graph and type-imports `process/errors.ts`; a walk
		// that counted that edge would list the target. Flip-verified by dropping the `type` test in
		// `specifiersOf`: the module appears and this fails.
		expect(graph.modules).toContain("shell/commands/dispatch.ts");
		expect(graph.modules).not.toContain("process/errors.ts");
		expect(graph.modules).not.toContain("shell/commands/kernel.ts");
	});

	it("a module window's type-only reach into its own program is not an edge either", () => {
		// `demo/module-window.tsx` type-imports `demo/module-counter.ts` for its event union. That
		// file calls `defineProgram` and so reaches `node:crypto`; counting the edge would both list
		// it here and red the leak test above, which is what #8946 reported from a browser.
		expect(graph.modules).not.toContain("demo/module-counter.ts");
		expect(graph.modules).not.toContain("authoring/define-program.ts");
	});
});
