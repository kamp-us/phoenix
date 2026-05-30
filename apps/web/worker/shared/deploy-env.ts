/**
 * Deploy-time worker env resolution.
 *
 * `worker/index.ts` declares the worker's `env` block, which is evaluated in the
 * alchemy CLI process at deploy time — so `process.env` here is the *deploy-time*
 * environment (`alchemy deploy` on CI / from an `--env-file`, or the offline
 * `alchemy dev` / Vitest loop), not the worker runtime.
 *
 * `ENVIRONMENT` gates every dev-only surface — the `/api/admin/*` seeder +
 * clear routes (`adminAllowed`), the `AdminAuth` capability, the magic-link
 * token `console.log`. It must resolve from `process.env.ENVIRONMENT`,
 * defaulting to `"development"` only when unset. A real deploy sets
 * `ENVIRONMENT=production` and every gate closes.
 */

/** The subset of the deploy-time process env this resolver reads. */
export interface DeployEnvInput {
	readonly ENVIRONMENT?: string | undefined;
	readonly CI?: string | undefined;
	readonly VITEST?: string | undefined;
	/**
	 * The alchemy `dev` flag, exclusively for `alchemy dev` (the offline local
	 * workerd loop). The `dev` CLI command spawns its exec subprocess with this
	 * JSON blob in the environment; `deploy`/`plan`/`destroy` run inline and never
	 * set it. So a parsed `dev: true` here is the genuine alchemy dev signal —
	 * available synchronously at module-eval, before any Effect/`AlchemyContext`
	 * is in scope.
	 *
	 * @see node_modules/alchemy/lib/Cli/commands/dev.js — sets `ALCHEMY_EXEC_OPTIONS`
	 */
	readonly ALCHEMY_EXEC_OPTIONS?: string | undefined;
	/**
	 * A coarser dev override (`"1"`/`"true"`) that alchemy's own test harness
	 * honors via `Core.resolveDev`. Treated as a dev signal here too for parity.
	 *
	 * @see node_modules/alchemy/lib/Test/Core.js — `resolveDev`
	 */
	readonly ALCHEMY_DEV?: string | undefined;
}

/** The safety-critical env fields the worker block resolves at deploy time. */
export interface ResolvedDeployEnv {
	readonly ENVIRONMENT: string;
}

/**
 * Resolve the deploy-time env.
 *
 * Pure over an injected snapshot so the resolution is unit-testable without
 * mutating the real `process.env`.
 */
export const resolveDeployEnv = (env: DeployEnvInput): ResolvedDeployEnv => ({
	ENVIRONMENT: env.ENVIRONMENT ?? "development",
});

/** Which alchemy state store the stack should use. */
export type StateMode = "local" | "cloudflare";

/**
 * Is this an offline alchemy path — `alchemy dev` or the Vitest integration
 * harness — where the file-based `localState()` is correct and required?
 *
 * Keyed off the **real dev-vs-deploy** signal, NOT `CI`. `CI` is set for BOTH
 * the deploy workflow and the test job, so it can't tell a real deploy from a
 * test run — the old `CI && !VITEST` heuristic therefore made a laptop
 * `alchemy deploy` (no `CI`) silently fall to local state, diverging from the
 * shared store. The genuine signals, all readable synchronously at module-eval
 * (before `AlchemyContext`/`ALCHEMY_PHASE` exist):
 *
 *   - `VITEST` — the integration harness must stay offline; it also forces its
 *     own `localState()` via `Core.run` options, so this is belt-and-suspenders.
 *   - alchemy's `dev` flag — `alchemy dev` spawns its exec subprocess with
 *     `dev: true` in `ALCHEMY_EXEC_OPTIONS`; `deploy` runs inline and never sets
 *     it. `ALCHEMY_DEV=1|true` is the coarser override the test harness honors.
 *
 * So a real `alchemy deploy` (dev unset) resolves to the shared store whether or
 * not `CI` is set, and only `dev`/Vitest stays local.
 */
const isOfflinePath = (env: DeployEnvInput): boolean => {
	if (env.VITEST) return true;

	const devOverride = env.ALCHEMY_DEV?.toLowerCase();
	if (devOverride === "1" || devOverride === "true") return true;

	if (env.ALCHEMY_EXEC_OPTIONS) {
		try {
			const parsed = JSON.parse(env.ALCHEMY_EXEC_OPTIONS) as {dev?: unknown};
			if (parsed.dev === true) return true;
		} catch {
			// A malformed blob is not a dev signal — fall through to deploy (shared
			// store). Failing safe toward the shared store keeps collab/diff intact.
		}
	}

	return false;
};

/**
 * Resolve which state store the alchemy stack should use.
 *
 * Pure over an injected snapshot so the selector is unit-testable without
 * mutating the real `process.env`.
 */
export const resolveStateMode = (env: DeployEnvInput): StateMode =>
	isOfflinePath(env) ? "local" : "cloudflare";
