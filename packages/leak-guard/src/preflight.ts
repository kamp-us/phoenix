/**
 * Dependency preflight (issue #777) — node-builtins only, NO `@effect/platform-node`.
 *
 * A static `import "@effect/platform-node"` throws `ERR_MODULE_NOT_FOUND` at module-load
 * on a not-yet-installed tree, before any handling runs — an unhandled crash with a
 * confusing stack rather than the bin's intentional exit-code signal. `depsInstalled`
 * resolves the heavy dep with `createRequire(...).resolve` (pure; imports nothing) so
 * the bin can detect the stale tree and exit with its documented "can't run" code.
 *
 * leak-guard's exit-code contract (#332): 2 = confirmed leak, 0 = clean, any OTHER
 * non-zero = the scan COULD NOT complete (pre-commit fail-opens warn+allow, CI
 * fail-closes). Missing deps are exactly the can't-run case, so the degraded exit is a
 * non-zero that is NEITHER 0 nor 2 — loud, and routed by the existing contract.
 */
import {createRequire} from "node:module";

/** The runtime dep whose absence on a not-yet-installed tree breaks the bins. */
export const RUNTIME_DEP = "@effect/platform-node";

/** The non-zero "could not run" exit (NOT 0=clean, NOT 2=leak) — see #332. */
export const CANT_RUN_EXIT_CODE = 3;

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
export const missingDepMessage = (dep: string = RUNTIME_DEP): string =>
	`leak-guard: ${dep} is not installed — run \`pnpm install\`. ` +
	`The scan could not run (exit ${CANT_RUN_EXIT_CODE}); pre-commit warns+allows, CI fails (issue #332/#777).`;
