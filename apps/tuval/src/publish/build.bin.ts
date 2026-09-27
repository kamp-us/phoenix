/**
 * Build the packed desk into `dist/` (#9690), the directory `publishConfig.directory` hands
 * `pnpm pack`: the page, built from `index.html`, at its root, where the page server finds it
 * (`../bin.ts`'s `appRoot`), and the `tuval` bin beside it under `server/`. `prepack` runs it, so a
 * `pnpm pack` of the app always packs a fresh build. What goes in the manifest is `./manifest.ts`'s.
 *
 * The page is still served by Vite at run time, as it is in the workspace: a program's window is a
 * module the page imports by specifier, and only a running page server can resolve one. So the built
 * page leaves the packages it shares with those windows as imports for that server to resolve.
 */

import {chmodSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import react from "@vitejs/plugin-react";
import {build, type Rolldown} from "vite";
import {
	BIN_PATH,
	bundledEdges,
	composeManifest,
	type Manifest,
	packageOf,
	pageExternal,
	readFrom,
	renderComposed,
	SDK_PACKAGE,
	serverExternal,
} from "./manifest.ts";

const APP = resolve(import.meta.dirname, "../..");
const OUT = join(APP, "dist");

const readManifest = (dir: string): Manifest =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

/** A dependency's own directory, through the link pnpm made for it beside its dependent. */
const linked = (from: string, name: string): string =>
	realpathSync(join(from, "node_modules", name));

/** Every workspace package the app reaches at run time, SDK aside, with its manifest. */
const bundledWorkspace = (): ReadonlyMap<string, Manifest> => {
	const found = new Map<string, Manifest>();
	const walk = (dir: string, manifest: Manifest): void => {
		for (const name of bundledEdges(manifest)) {
			if (found.has(name)) continue;
			const depDir = linked(dir, name);
			const dep = readManifest(depDir);
			found.set(name, dep);
			walk(depDir, dep);
		}
	};
	walk(APP, readManifest(APP));
	return found;
};

/** `external`, recording each package it left out. */
const recording =
	(external: (specifier: string) => boolean, imports: Set<string>) =>
	(specifier: string): boolean => {
		if (!external(specifier)) return false;
		const name = packageOf(specifier);
		if (name !== null) imports.add(name);
		return true;
	};

const moduleIdsOf = (output: Awaited<ReturnType<typeof build>>): ReadonlyArray<string> =>
	(Array.isArray(output) ? output : [output])
		.flatMap((one) => ("output" in one ? one.output : []))
		.flatMap((chunk: Rolldown.OutputChunk | Rolldown.OutputAsset) =>
			chunk.type === "chunk" ? chunk.moduleIds : [],
		);

const fail = (message: string): never => {
	process.stderr.write(`tuval build: ${message}\n`);
	process.exit(1);
};

rmSync(OUT, {recursive: true, force: true});
const app = readManifest(APP);
const bundled = bundledWorkspace();
const imports = new Set<string>();

const page = await build({
	root: APP,
	configFile: false,
	logLevel: "warn",
	plugins: [react()],
	build: {
		outDir: OUT,
		emptyOutDir: false,
		reportCompressedSize: false,
		rolldownOptions: {external: recording(pageExternal, imports)},
	},
});

const server = await build({
	root: APP,
	configFile: false,
	publicDir: false,
	logLevel: "warn",
	build: {
		ssr: "src/bin.ts",
		outDir: join(OUT, dirname(BIN_PATH)),
		emptyOutDir: false,
		reportCompressedSize: false,
		rolldownOptions: {
			external: recording(serverExternal(new Set(bundled.keys())), imports),
			output: {
				entryFileNames: "bin.js",
				chunkFileNames: "[name]-[hash].js",
				banner: "#!/usr/bin/env node",
			},
		},
	},
	ssr: {noExternal: true, target: "node"},
});

const sdkCopy = readFrom([...moduleIdsOf(page), ...moduleIdsOf(server)], linked(APP, SDK_PACKAGE));
if (sdkCopy.length > 0) {
	fail(`the desk bundled its own copy of ${SDK_PACKAGE}:\n  ${sdkCopy.join("\n  ")}`);
}

const composed = composeManifest({app, bundled: [...bundled.values()], imports});
if (composed._tag !== "Composed") fail(renderComposed(composed));
else writeFileSync(join(OUT, "package.json"), `${JSON.stringify(composed.manifest, null, "\t")}\n`);
chmodSync(join(OUT, BIN_PATH), 0o755);
process.stdout.write(`tuval build: packed desk built in ${OUT}\n`);
