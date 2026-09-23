/**
 * The claim `@kampus/tuval-sdk/window` makes, checked rather than asserted in a docblock: nothing a
 * browser loads through that door reaches a `node:` builtin.
 *
 * This is the criterion #8943 states for the browser-side subpath, and it is a property of the
 * *value*-import closure specifically. A type-only import is erased before a bundler ever sees it,
 * so `import type {ProcessId} from "../process/process.ts"` is not a way for `node:crypto` to reach
 * a page; a bare `import {…}` is. The walk below follows exactly that edge and no other.
 *
 * The same walk is run over `./index.ts` as a control. It is expected to reach `node:crypto` — that
 * is why the two doors are two — and asserting it here means the test cannot quietly pass by having
 * stopped following edges at all.
 *
 * Deliberately a source walk, not a resolver: what is being pinned is the text of the imports, and
 * a claim about what a bundler pulls has to be read off the same statements the bundler reads.
 */

import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {describe, expect, it} from "vitest";

/**
 * One import or export statement with a module specifier. `import type …` / `export type …` are
 * erased whole and are skipped; a statement with inline `type` specifiers (`import {type A, b}`)
 * is followed, which over-counts rather than under-counts and is the safe direction for this test.
 */
const SPECIFIERS = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s*["']([^"']+)["']/gm;

/** A bare `import "./x.ts"` for its side effects — no clause, still a value edge. */
const SIDE_EFFECTS = /^\s*import\s*["']([^"']+)["']/gm;

interface Closure {
	/** Every repo file reachable by a value edge, the entry included. */
	readonly files: ReadonlySet<string>;
	/** Every bare specifier those files import as values — `node:*` and packages alike. */
	readonly bare: ReadonlySet<string>;
}

const walk = (entry: string): Closure => {
	const files = new Set<string>();
	const bare = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || files.has(file)) continue;
		files.add(file);
		const source = readFileSync(file, "utf8");
		const specifiers = [
			...[...source.matchAll(SPECIFIERS)].map((m) => m[1]),
			...[...source.matchAll(SIDE_EFFECTS)].map((m) => m[1]),
		];
		for (const specifier of specifiers) {
			if (specifier === undefined) continue;
			if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
			else bare.add(specifier);
		}
	}
	return {files, bare};
};

const target = (subpath: string): string => {
	const root = resolve(import.meta.dirname, "../..");
	const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
		readonly exports: Readonly<Record<string, string>>;
	};
	const declared = manifest.exports[subpath];
	if (declared === undefined) throw new Error(`the exports map declares no ${subpath}`);
	return resolve(root, declared);
};

const nodeBuiltins = (closure: Closure): ReadonlyArray<string> =>
	[...closure.bare].filter((specifier) => specifier.startsWith("node:")).sort();

describe("the ./window door is browser-safe", () => {
	it("reaches no node: builtin anywhere in its value-import closure", () => {
		const closure = walk(target("./window"));
		expect(nodeBuiltins(closure)).toEqual([]);
		// The walk has to have actually walked: naming the two modules `windowRenderer` is reached
		// through is a sharper liveness check than a count, because a walker that stopped following
		// edges would pass the line above with an empty closure.
		const reached = [...closure.files].map((file) => file.split("/src/")[1]);
		expect(reached).toContain("shell/window/index.ts");
		expect(reached).toContain("shell/window/renderer.ts");
	});

	it("pulls no package a page cannot load either", () => {
		const closure = walk(target("./window"));
		expect([...closure.bare].sort()).toEqual(["effect"]);
	});

	it("is what `view.ts` itself is, too — the claim this door used to be declined on", () => {
		// The window surface's types come from `./view.ts`, and the earlier head of this branch said
		// that module's chain reaches `node:crypto`. It does not, and the fact is pinned here rather
		// than left to a docblock: `view.ts`'s own value closure is clean, which is why the door
		// below it can be opened at all.
		expect(nodeBuiltins(walk(resolve(import.meta.dirname, "view.ts")))).toEqual([]);
	});
});

describe("the ./authoring door is the kernel-side one, and that is why there are two", () => {
	it("does reach node:crypto, which is the control on the walk above", () => {
		expect(nodeBuiltins(walk(target("./authoring")))).toContain("node:crypto");
	});
});
