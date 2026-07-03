/**
 * The impure boundary: bundle the `apps/web` worker entry headlessly with the
 * SAME bundler the alchemy deploy uses (rolldown + @distilled.cloud's cloudflare
 * plugin), then lower rolldown's output into a pure {@link BundleGraph} for the
 * detector. No `alchemy deploy`, no live Cloudflare account — a plain rolldown
 * build on the runner (ADR 0054-adjacent, #1836).
 *
 * We do NOT add rolldown / the cloudflare plugin as direct deps: they are
 * alchemy's transitive deps, and resolving them THROUGH alchemy's own install
 * guarantees byte-identical bundler versions to the real deploy — no catalog
 * version to drift, no second copy in the lockfile. The config mirrors alchemy's
 * `WorkerBundle` input/output options (external `lightningcss`/`fsevents`, the
 * `__ALCHEMY_RUNTIME__` define, `format:esm` + `minify` so DCE matches the shipped
 * artifact). See `alchemy/lib/Cloudflare/Workers/WorkerBundle.js`.
 */
import {readFileSync, realpathSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {BundleGraph} from "./detect.ts";

// alchemy's default when the worker sets no explicit compatibility date
// (worker/index.ts pins only `flags: ["nodejs_compat"]`). Sourced from
// alchemy@2.0.0-beta.59 `Compatibility.js` DEFAULT_COMPATIBILITY_DATE — re-key on
// an alchemy bump. The forbidden-set detection is date-insensitive (child_process/
// inspector are never workerd-supported; winston/pino are npm), so this only keeps
// the node-builtin polyfill resolution faithful to the deploy.
const COMPATIBILITY_DATE = "2026-03-17";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

// Minimal structural types for the dynamically-resolved rolldown API — rolldown is
// alchemy's transitive dep, NOT a direct dep of apps/web, so it has no resolvable
// type import here. We only touch `rolldown()` → `.generate()` → output chunks.
interface RolldownChunk {
	readonly type: string;
	readonly moduleIds?: ReadonlyArray<string>;
	readonly imports?: ReadonlyArray<string>;
	readonly dynamicImports?: ReadonlyArray<string>;
}
interface RolldownBuild {
	generate(opts: unknown): Promise<{output: ReadonlyArray<RolldownChunk>}>;
	close(): Promise<void>;
}
interface RolldownModule {
	rolldown(opts: unknown): Promise<RolldownBuild>;
}

/** Resolve a package's ESM entry from its own `package.json` (its dir is known). */
const esmEntry = (pkgDir: string): string => {
	const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	const exp = pkg.exports;
	let sub: unknown;
	if (typeof exp === "string") sub = exp;
	else if (exp && typeof exp === "object") {
		const dot = (exp as Record<string, unknown>)["."] ?? exp;
		sub =
			typeof dot === "string"
				? dot
				: ((dot as Record<string, unknown>).import ??
					(dot as Record<string, unknown>).module ??
					(dot as Record<string, unknown>).default);
		if (sub && typeof sub === "object")
			sub = (sub as Record<string, unknown>).import ?? (sub as Record<string, unknown>).default;
	}
	sub = sub ?? pkg.module ?? pkg.main ?? "index.js";
	return path.join(pkgDir, String(sub));
};

/**
 * Bundle `apps/web/worker/index.ts` and return the reachable module graph.
 * `webRoot` is the `apps/web` package dir (the cwd the CI step runs from).
 */
export const bundleWorkerGraph = async (webRoot: string): Promise<BundleGraph> => {
	// alchemy's real install dir, and the pnpm virtual-store dir holding its
	// siblings (rolldown, the cloudflare plugin).
	const alchemyRoot = realpathSync(path.join(webRoot, "node_modules/alchemy"));
	const depsRoot = path.dirname(alchemyRoot);
	const rolldownDir = realpathSync(path.join(depsRoot, "rolldown"));
	const pluginDir = realpathSync(
		path.join(depsRoot, "@distilled.cloud/cloudflare-rolldown-plugin"),
	);

	const rolldown = (await import(pathToFileURL(esmEntry(rolldownDir)).href)) as RolldownModule;
	const pluginMod = await import(pathToFileURL(esmEntry(pluginDir)).href);
	const cloudflareRolldown = (pluginMod.default ?? pluginMod) as (opts: {
		compatibilityDate: string;
		compatibilityFlags: string[];
	}) => unknown;

	const bundle = await rolldown.rolldown({
		input: path.join(webRoot, "worker/index.ts"),
		// forever-devtool native modules referenced behind runtime guards; rolldown
		// resolves before DCE, so mark them external (matches WorkerBundle.js).
		external: ["lightningcss", "fsevents"],
		plugins: [
			cloudflareRolldown({
				compatibilityDate: COMPATIBILITY_DATE,
				compatibilityFlags: COMPATIBILITY_FLAGS,
			}),
		],
		transform: {define: {"globalThis.__ALCHEMY_RUNTIME__": "true"}},
		optimization: {inlineConst: {mode: "smart", pass: 3}},
		checks: {unresolvedImport: false, ineffectiveDynamicImport: false},
	});
	// `generate` (in-memory) not `write` — we only need the graph, no artifact on disk.
	// close() in finally so a generate() throw still tears the build down (a leaked
	// rolldown build hangs CI instead of failing cleanly).
	let output: ReadonlyArray<RolldownChunk>;
	try {
		({output} = await bundle.generate({
			format: "esm",
			minify: true,
			keepNames: true,
			sourcemap: "hidden",
		}));
	} finally {
		await bundle.close();
	}

	const moduleIds = new Set<string>();
	const externalImports = new Set<string>();
	for (const chunk of output) {
		if (chunk.type !== "chunk") continue;
		for (const id of chunk.moduleIds ?? []) moduleIds.add(id);
		for (const imp of chunk.imports ?? []) externalImports.add(imp);
		for (const imp of chunk.dynamicImports ?? []) externalImports.add(imp);
	}
	return {moduleIds: [...moduleIds], externalImports: [...externalImports]};
};
