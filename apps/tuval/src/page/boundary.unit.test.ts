/**
 * The page is Node-free, proven by walking its runtime import graph. Vite externalizes a `node:`
 * module in client code and the first property read throws at load, so a kernel-side layer placed
 * beside a tag the page reaches blanks the whole desk with green CI behind it (#7910: `Processes`
 * reached `src/shell/commands/dispatch.ts` through `shell/ui/CommandLine.tsx`). Walking the graph from
 * the entry names the offending chain rather than the symptom.
 *
 * Only runtime edges count: an `import type` is erased by the bundler and reaches nothing.
 */

import {existsSync, readFileSync} from "node:fs";
import {builtinModules} from "node:module";
import {dirname, join, relative, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const ENTRY = resolve(import.meta.dirname, "main.tsx");
const SRC = resolve(import.meta.dirname, "..");
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

/** Depth-first over relative imports, recording each `node:` edge with the chain that reached it. */
const walk = (): {
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
	visit(ENTRY, []);
	return {modules: [...seen].map((file) => relative(SRC, file)), leaks};
};

describe("the page's import graph", () => {
	const graph = walk();

	it("reaches the shell, so the walk is not vacuous", () => {
		expect(graph.modules.length).toBeGreaterThan(20);
		expect(graph.modules).toEqual(
			expect.arrayContaining(["shell/commands/index.ts", "shell/commands/dispatch.ts"]),
		);
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
});
