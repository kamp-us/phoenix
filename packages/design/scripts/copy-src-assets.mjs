#!/usr/bin/env node
/**
 * Copy every file under `src/` that `tsc` does not emit to the same relative path under `dist/`.
 *
 * The components import their stylesheets (`import "./Button.css"`), and `tsc` keeps those import
 * lines while emitting no `.css`, so without this copy every built module points at a missing file.
 * The rule is every non-TypeScript file rather than `.css` alone, so a new asset kind ships
 * without anyone remembering to list it.
 */
import {copyFileSync, mkdirSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_ROOT, "src");
const DIST = join(PACKAGE_ROOT, "dist");

const assets = readdirSync(SRC, {recursive: true, withFileTypes: true})
	.filter((entry) => entry.isFile() && !/\.tsx?$/.test(entry.name))
	.map((entry) => join(entry.parentPath, entry.name).slice(SRC.length + 1))
	.sort();

for (const asset of assets) {
	const target = join(DIST, asset);
	mkdirSync(dirname(target), {recursive: true});
	copyFileSync(join(SRC, asset), target);
}
console.log(`copy-src-assets: copied ${assets.length} asset(s) from src/ to dist/`);
