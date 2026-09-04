/**
 * The "Turkish path ships zero English bytes" proof (ADR 0347).
 *
 * Two halves, because either alone is a hole. The bundle half really bundles `catalog.ts` with
 * rolldown and asserts the entry chunk carries the Turkish strings and none of the English ones,
 * with `en` landing in a chunk of its own — a static `import` there would collapse them into one
 * chunk and red this. The source half then scans every module under `src/` for a static import of
 * the `en` catalog, because a second importer anywhere else would pull English into the main
 * bundle while `catalog.ts` alone still split cleanly.
 *
 * rolldown is resolved out of alchemy's install exactly as `scripts/bundle-assert/bundle.ts` does
 * it — it is not a direct dep, and going through alchemy keeps one bundler version in the tree.
 */
import {readdirSync, readFileSync, realpathSync} from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {describe, expect, it} from "vitest";
import {en} from "./en";
import {tr} from "./tr";

interface RolldownChunk {
	readonly type: string;
	readonly isEntry?: boolean;
	readonly code?: string;
}
interface RolldownBuild {
	generate(opts: unknown): Promise<{output: ReadonlyArray<RolldownChunk>}>;
	close(): Promise<void>;
}
interface RolldownModule {
	rolldown(opts: unknown): Promise<RolldownBuild>;
}

const I18N_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = path.dirname(I18N_DIR);
const WEB_ROOT = path.dirname(SRC_DIR);

/** Resolve a package's ESM entry from its own `package.json` (its dir is known). */
function esmEntry(pkgDir: string): string {
	const pkg: {exports?: unknown; module?: string; main?: string} = JSON.parse(
		readFileSync(path.join(pkgDir, "package.json"), "utf8"),
	);
	const exp = pkg.exports;
	let sub: unknown;
	if (typeof exp === "string") sub = exp;
	else if (exp && typeof exp === "object") {
		const record: Record<string, unknown> = {...exp};
		const dot = record["."] ?? record;
		if (typeof dot === "string") sub = dot;
		else if (dot && typeof dot === "object") {
			const inner: Record<string, unknown> = {...dot};
			sub = inner.import ?? inner.module ?? inner.default;
			if (sub && typeof sub === "object") {
				const nested: Record<string, unknown> = {...sub};
				sub = nested.import ?? nested.default;
			}
		}
	}
	return path.join(pkgDir, String(sub ?? pkg.module ?? pkg.main ?? "index.js"));
}

async function bundleCatalogChunks(): Promise<ReadonlyArray<RolldownChunk>> {
	const alchemyRoot = realpathSync(path.join(WEB_ROOT, "node_modules/alchemy"));
	const rolldownDir = realpathSync(path.join(path.dirname(alchemyRoot), "rolldown"));
	const rolldown: RolldownModule = await import(pathToFileURL(esmEntry(rolldownDir)).href);
	const build = await rolldown.rolldown({input: path.join(I18N_DIR, "catalog.ts")});
	try {
		const {output} = await build.generate({format: "esm"});
		return output.filter((chunk) => chunk.type === "chunk");
	} finally {
		await build.close();
	}
}

function tsFilesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...tsFilesUnder(full));
		else if (/\.tsx?$/.test(entry.name)) found.push(full);
	}
	return found;
}

const TR_SAMPLE = tr["layout.skipToContent"];
const EN_SAMPLE = en["layout.skipToContent"];

describe("the en catalog stays off the Turkish path", () => {
	it("splits en into its own chunk, leaving the entry Turkish-only", async () => {
		const chunks = await bundleCatalogChunks();
		const entry = chunks.find((chunk) => chunk.isEntry);
		expect(entry).toBeDefined();
		expect(entry?.code).toContain(TR_SAMPLE);
		expect(entry?.code).not.toContain(EN_SAMPLE);

		const englishChunks = chunks.filter(
			(chunk) => !chunk.isEntry && chunk.code?.includes(EN_SAMPLE),
		);
		expect(englishChunks.length).toBe(1);
	}, 60_000);

	it("is reached from shipped code only through the dynamic import in catalog.ts", () => {
		expect(readFileSync(path.join(I18N_DIR, "catalog.ts"), "utf8")).toContain('import("./en")');

		// A static `from "…/en"` specifier. The dynamic form carries no `from`, so it never
		// matches. Tests are exempt: they are not in the shipped graph, and grading both
		// catalogs is exactly what the brand-noun invariant does.
		const staticImporters = tsFilesUnder(SRC_DIR)
			.filter((file) => !/\.test\.tsx?$/.test(file))
			.filter((file) => /\bfrom\s+["'][^"']*\/en(\/index)?["']/.test(readFileSync(file, "utf8")))
			.map((file) => path.relative(WEB_ROOT, file));
		expect(staticImporters).toEqual([]);
	});
});
