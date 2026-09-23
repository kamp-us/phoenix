/**
 * Where `@kampus/tuval`'s source sits on disk, for the tests here that read a kernel module's text
 * rather than import it: boundary walks, field-name checks, a config module booted by path. Paths
 * are found through the package's own `exports` map, so they follow the SDK wherever the workspace
 * links it and never hard-code a path into `packages/`.
 */

import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@kampus/tuval/package.json");
const root = dirname(manifestPath);
const exportsMap = (
	JSON.parse(readFileSync(manifestPath, "utf8")) as {readonly exports: Record<string, string>}
).exports;

/** The SDK's `src/` directory. */
export const sdkSrc = join(root, "src");

/** The absolute path of one SDK module, named from `src/` (`process/process.ts`). */
export const sdkModule = (path: string): string => join(sdkSrc, path);

/**
 * The file a `@kampus/tuval/…` specifier loads, read off the exports map the way a bundler reads it
 * (an exact key first, then a `/*` pattern), or `undefined` for a specifier that is not the SDK's.
 * A source walk that stops at the package boundary would stop seeing the kernel it used to walk.
 */
export const resolveSdkSpecifier = (specifier: string): string | undefined => {
	if (!specifier.startsWith("@kampus/tuval/")) return undefined;
	const subpath = `.${specifier.slice("@kampus/tuval".length)}`;
	const exact = exportsMap[subpath];
	if (exact !== undefined) return join(root, exact);
	for (const [key, target] of Object.entries(exportsMap)) {
		if (!key.endsWith("/*") || !subpath.startsWith(key.slice(0, -1))) continue;
		return join(root, target.replace("*", subpath.slice(key.length - 1)));
	}
	return undefined;
};
