/**
 * Bundle the worker entry offline and return its module graph for ADR 0118's guard.
 * Resolve the bundler and Cloudflare plugin through Alchemy's installation so the
 * guard uses the deployment's versions. Options follow beta.77's
 * lib/Cloudflare/Workers/Sources/Rolldown.js and lib/Bundle/Bundle.js.
 */
import {readFileSync, realpathSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {BundleGraph} from "./detect.ts";

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
const esmEntry = (pkgDir: string, subpath = "."): string => {
	const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	const exp = pkg.exports;
	let sub: unknown;
	if (typeof exp === "string") sub = exp;
	else if (exp && typeof exp === "object") {
		const dot = (exp as Record<string, unknown>)[subpath] ?? (subpath === "." ? exp : undefined);
		if (dot === undefined) throw new Error(`Missing export ${subpath} in ${pkgDir}`);
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
	const pluginDir = realpathSync(path.join(depsRoot, "@alchemy.run/cloudflare-runtime"));

	const rolldown = (await import(pathToFileURL(esmEntry(rolldownDir)).href)) as RolldownModule;
	const pluginMod = await import(pathToFileURL(esmEntry(pluginDir, "./rolldown")).href);
	const {esmExternalRequirePlugin} = await import(
		pathToFileURL(esmEntry(rolldownDir, "./plugins")).href
	);
	const {getCompatibility} = await import(
		pathToFileURL(path.join(alchemyRoot, "lib/Cloudflare/Workers/Compatibility.js")).href
	);
	const compatibility = getCompatibility({compatibility: {flags: ["nodejs_compat"]}});
	const cloudflareRolldown = (pluginMod.default ?? pluginMod) as (opts: {
		compatibilityDate: string;
		compatibilityFlags: string[];
	}) => unknown[];
	const plugins = cloudflareRolldown({
		compatibilityDate: compatibility.date,
		compatibilityFlags: compatibility.flags,
	}).map((plugin) => {
		// Rolldown recognizes builtins by class identity, so use its own instance.
		if (
			typeof plugin === "object" &&
			plugin !== null &&
			"name" in plugin &&
			plugin.name === "builtin:esm-external-require" &&
			"_options" in plugin
		) {
			return esmExternalRequirePlugin(plugin._options);
		}
		return plugin;
	});

	const bundle = await rolldown.rolldown({
		input: path.join(webRoot, "worker/index.ts"),
		cwd: webRoot,
		// forever-devtool native modules referenced behind runtime guards; rolldown
		// resolves before DCE, so mark them external (matches Sources/Rolldown.js).
		external: ["lightningcss", "fsevents"],
		plugins,
		transform: {define: {"globalThis.__ALCHEMY_RUNTIME__": "true"}},
		moduleTypes: {".sql": "text", ".txt": "text", ".html": "text"},
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
			strictExecutionOrder: true,
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
