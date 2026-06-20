/**
 * Dependency preflight (issue #777) — node-builtins only, NO `@effect/platform-node`.
 *
 * The bin statically `import`s `@effect/platform-node`; on a not-yet-installed tree
 * that import throws `ERR_MODULE_NOT_FOUND` at module-load — before any in-bin handling
 * runs — and the harness silently fail-opens (or, for the statusline, blanks visibly,
 * #758). `depsInstalled` resolves the heavy dep with `createRequire(...).resolve` (pure;
 * imports nothing), so the bin can detect the stale tree and degrade per-subcommand:
 * the `guard` PreToolUse hook fails CLOSED with a `deny` (ADR 0092), the statusline
 * renders a loud placeholder — both LOUD, neither a silent no-op.
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

/**
 * The degraded `guard` hook output when the runtime dep is missing: a fail-CLOSED
 * `deny` (ADR 0092 — an indeterminate guard blocks, never silently allows) whose reason
 * names the missing dep so the refusal is observable, plus a stderr note. Returns the
 * stdout JSON line; the caller writes the stderr note.
 */
export const degradedGuardDeny = (dep: string = RUNTIME_DEP): string =>
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason:
				`spawn-guard: DENY — ${dep} is not installed (run \`pnpm install\`); ` +
				`the spawn-model allowlist guard cannot run, so it fails closed (ADR 0092, issue #777).`,
		},
		systemMessage: `spawn-guard: deps not installed — fail-closed DENY (run \`pnpm install\`)`,
	});

/** The degraded statusline line — a visible placeholder, never a blank/crash (#758). */
export const degradedStatusline = (): string => "spawn-guard: deps not installed (pnpm install)";

/** The loud stderr note shown when the runtime dep is missing. */
export const missingDepMessage = (subcommand: string, dep: string = RUNTIME_DEP): string =>
	`spawn-guard ${subcommand}: ${dep} is not installed — run \`pnpm install\` (issue #777).`;

/**
 * The proactive SessionStart freshness signal (#835): when the hook-pack's runtime dep
 * is unresolvable, the whole hook pack is degraded (read-guard / worktree-guard fail
 * open or loud, the statusline placeholder-renders) until `pnpm install` runs. #834
 * surfaces that at hook-FIRE time per bin; this is the UP-FRONT detector so the gap is
 * flagged before a hook even fires. Returns `null` when deps resolve — a healthy session
 * gets NO output (never spam a fresh tree). The string is the `additionalContext` body
 * the SessionStart hook hands the agent so it can tell the user to run `pnpm install`.
 */
export const freshnessSignal = (dep: string = RUNTIME_DEP): string | null =>
	depsInstalled(dep)
		? null
		: `Hook deps not installed — run \`pnpm install\`. The phoenix hook-pack's runtime ` +
			`dep (\`${dep}\`) is unresolvable, so the read-guard / worktree-guard / spawn-guard ` +
			`hooks are DEGRADED (not enforcing) and the statusline is a placeholder, until deps ` +
			`are installed (issue #835). Tell the user to run \`pnpm install\` from the repo root.`;
