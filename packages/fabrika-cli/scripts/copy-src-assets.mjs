#!/usr/bin/env node
/**
 * Copy every non-TypeScript file under `src/` to the same relative path under `dist/`.
 *
 * `tsc` emits `.js`/`.d.ts` and nothing else, so a file no module imports never reaches `dist/`.
 * `lane/command.ts` resolves its two workflow templates by path off `import.meta.url`, which under
 * `dist/` is `dist/lane/templates/…` — a directory the compiler never created, so the published
 * package booted no lane at all and `lane open` exited on the unreadable-template code (#6011).
 *
 * The rule is total on purpose: **every** non-`.ts` file, with no exception list. An exception list
 * is where the next unshipped asset hides, and it can only be maintained by whoever adds an asset
 * remembering that reading it by path is different from importing it. The whole set is a few
 * kilobytes, so shipping a test fixture costs nothing next to shipping a package that cannot run.
 */
import {copyFileSync, mkdirSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_ROOT, "src");
const DIST = join(PACKAGE_ROOT, "dist");

/** Every file under `src/` that `tsc` will not emit, as paths relative to `src/`. */
const assets = readdirSync(SRC, {recursive: true, withFileTypes: true})
	.filter((entry) => entry.isFile() && !entry.name.endsWith(".ts"))
	.map((entry) => join(entry.parentPath, entry.name).slice(SRC.length + 1))
	.sort();

for (const asset of assets) {
	const target = join(DIST, asset);
	mkdirSync(dirname(target), {recursive: true});
	copyFileSync(join(SRC, asset), target);
}
console.log(`copy-src-assets: copied ${assets.length} asset(s) from src/ to dist/`);
