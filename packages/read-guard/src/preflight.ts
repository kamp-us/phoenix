/**
 * Dependency preflight (issue #777) — node-builtins only, NO `@effect/platform-node`.
 *
 * The hook-pack bins statically `import {NodeRuntime, NodeServices} from
 * "@effect/platform-node"`. On a checkout that has not yet run `pnpm install` after
 * the hook-pack merge, that import throws `ERR_MODULE_NOT_FOUND` at module-load —
 * *before* any in-bin fail-open `catch` can run. The hook then exits non-zero with no
 * JSON on stdout and the harness silently fail-opens: read-guard reads as installed
 * while enforcing nothing (the silent-no-op class ADR 0092 exists to kill).
 *
 * `depsInstalled` resolves the heavy dep with `createRequire(...).resolve` — a pure
 * module-resolution probe that pulls in nothing — so the bin can detect the stale-tree
 * case and degrade LOUD (a visible stderr note) before the heavy dynamic import runs.
 */
import {createRequire} from "node:module";

/** The runtime dep whose absence on a not-yet-installed tree breaks the bins. */
export const RUNTIME_DEP = "@effect/platform-node";

/**
 * Is `dep` resolvable from `fromUrl` (default: this module)? `false` ⇒ stale
 * `node_modules` (pre-`pnpm install`). Pure: resolves a specifier, imports nothing.
 */
export const depsInstalled = (
	dep: string = RUNTIME_DEP,
	fromUrl: string = import.meta.url,
): boolean => {
	try {
		createRequire(fromUrl).resolve(dep);
		return true;
	} catch {
		return false;
	}
};

/** The loud stderr note shown when the runtime dep is missing. */
export const missingDepMessage = (bin: string, dep: string = RUNTIME_DEP): string =>
	`${bin}: ${dep} is not installed — run \`pnpm install\`. ` +
	`Hook degraded to fail-open ALLOW; it is NOT enforcing until deps are installed (issue #777).`;
