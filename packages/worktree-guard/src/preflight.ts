/**
 * Dependency preflight (issue #777) — node-builtins only, NO `@effect/platform-node`.
 *
 * A static `import "@effect/platform-node"` throws `ERR_MODULE_NOT_FOUND` at module-load
 * on a not-yet-installed tree, before any handling runs, and the harness silently
 * fail-opens. `depsInstalled` resolves the heavy dep with `createRequire(...).resolve`
 * (pure; imports nothing) so the bin can detect the stale tree and degrade LOUD.
 *
 * worktree-guard's documented posture is fail-OPEN: an UNSET `$WORKTREE_ROOT` already
 * makes every subcommand a clean allow/skip no-op (a non-worktree session is unaffected).
 * So on a stale tree the PreToolUse subcommands degrade to that same `allow` (plus a loud
 * stderr note so the gap is visible), and the SubagentStop `reap` degrades to a skip —
 * never an unhandled crash, never a silent no-op.
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

/** The degraded PreToolUse output — a plain `allow` (worktree-guard's fail-open posture). */
export const degradedAllow = (): string =>
	JSON.stringify({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"}});

/** The loud stderr note shown when the runtime dep is missing. */
export const missingDepMessage = (subcommand: string, dep: string = RUNTIME_DEP): string =>
	`worktree-guard ${subcommand}: ${dep} is not installed — run \`pnpm install\`. ` +
	`Hook degraded (fail-open allow / reap-skip); it is NOT enforcing until deps are installed (issue #777).`;
