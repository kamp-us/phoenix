/**
 * Every Vite proof page loads the page's stylesheet order and declares the themes its tokens are
 * scoped under.
 *
 * The board's entry drifted off both and nothing noticed (#8798): it imported `../../ui/tokens.css`
 * alone, which once declared Tuval's roles itself and later became a two-name file consuming
 * `@kampus/design`'s layer. The page still built, still served and logged nothing — it rendered the
 * whole board in Times on a transparent body, and `.fabrika.jsonc`'s `uiSurfaces` points the
 * rendered design gate at exactly these pages, so the gate captured that render and called it
 * evidence. The only signal was the pixels.
 *
 * So the check lives here rather than in the page: a proof page is the surface under test, and an
 * assertion inside it would be judging its own capture.
 *
 * The entry set is derived — a directory named `proof` holding a `vite.config.ts` — so a proof entry
 * added later is covered without touching this file. Within one entry every `*.html` is a page,
 * because the chat and Pi-window entries serve several beside `index.html` and the gate can be
 * pointed at any of them. Each page's module is read off its own `<script type="module">`, not
 * assumed to be `main.tsx`.
 */

import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const APP = resolve(SRC, "..");
const STYLES = resolve(SRC, "page/styles.ts");

/** Directories under `src/` named `proof` that Vite serves — the non-Vite proof servers have no config. */
const viteProofEntries = (): ReadonlyArray<string> => {
	const found: Array<string> = [];
	const visit = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const child = join(dir, name);
			if (!statSync(child).isDirectory()) continue;
			if (name === "proof" && existsSync(join(child, "vite.config.ts"))) found.push(child);
			visit(child);
		}
	};
	visit(SRC);
	return found;
};

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
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
};

/** Depth-first over relative imports; a `.css` leaf is recorded and not read further. */
const graphOf = (entry: string): ReadonlySet<string> => {
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		if (file.endsWith(".css")) return;
		for (const specifier of specifiersOf(file)) {
			if (!specifier.startsWith(".")) continue;
			const next = resolveRelative(file, specifier);
			if (next !== undefined) visit(next);
		}
	};
	visit(entry);
	return seen;
};

const htmlTagOf = (html: string): string | undefined => /<html\b[^>]*>/i.exec(html)?.[0];

const moduleSrcOf = (html: string): string | undefined =>
	/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1];

type Page = {
	readonly name: string;
	readonly file: string;
	readonly entry: string;
};

const pagesOf = (entry: string): ReadonlyArray<Page> =>
	readdirSync(entry)
		.filter((name) => name.endsWith(".html"))
		.sort()
		.map((name) => ({name: relative(SRC, join(entry, name)), file: join(entry, name), entry}));

const entries = viteProofEntries();
const pages = entries.flatMap(pagesOf);

describe("the Vite proof entries", () => {
	it("are derived from the tree, and an empty derivation is a failure", () => {
		expect(entries.map((entry) => relative(SRC, entry))).not.toEqual([]);
	});

	it("each serve at least one page", () => {
		for (const entry of entries) {
			expect(pagesOf(entry).map((page) => page.name)).not.toEqual([]);
		}
	});
});

// Flip-verified against the drift this exists for: pointing `shell/board/proof/main.tsx` back at
// `../../ui/tokens.css` and dropping the two attributes off its `<html>` reds both of these and
// nothing else.
describe.each(pages)("$name", (page) => {
	const html = readFileSync(page.file, "utf8");

	it("reaches the page's stylesheet order", () => {
		const src = moduleSrcOf(html);
		expect(src, "no <script type=module src> to walk").toBeDefined();
		const module =
			src?.startsWith("/") === true
				? resolve(APP, `.${src}`)
				: resolveRelative(page.file, src as string);
		expect(module, `unresolvable module ${String(src)}`).toBeDefined();
		const graph = graphOf(module as string);
		// A graph of one is the module itself: the walk resolved nothing, so a hit would be luck.
		expect(graph.size).toBeGreaterThan(1);
		expect([...graph].map((file) => relative(SRC, file))).toContain(relative(SRC, STYLES));
	});

	it("carries both theme attributes on <html>", () => {
		const tag = htmlTagOf(html);
		expect(tag, "no <html> element").toBeDefined();
		expect(tag).toMatch(/\bdata-theme=/);
		expect(tag).toMatch(/\bdata-color-theme=/);
	});
});
