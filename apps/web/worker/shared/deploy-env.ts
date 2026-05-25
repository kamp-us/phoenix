/**
 * Deploy-time worker env resolution (fail-closed).
 *
 * `worker/index.ts` declares the worker's `env` block, which is evaluated in the
 * alchemy CLI process at deploy time — so `process.env` here is the *deploy-time*
 * environment (`alchemy deploy` on CI / from an `--env-file`, or the offline
 * `alchemy dev` / Vitest loop), not the worker runtime.
 *
 * Two of those vars are safety-critical and resolved here so the policy lives in
 * one tested place:
 *
 *   - `ENVIRONMENT` gates every dev-only surface — the `/api/admin/*` seeder +
 *     clear routes (`adminAllowed`), the `AdminAuth` capability, the magic-link
 *     token `console.log`. It must resolve from `process.env.ENVIRONMENT`,
 *     defaulting to `"development"` only when unset. A real deploy sets
 *     `ENVIRONMENT=production` and every gate closes.
 *   - `BETTER_AUTH_SECRET` signs sessions. On the offline/dev path it falls back
 *     to a fixed non-secret so local sign-in works with no configuration; on a
 *     real deploy a missing secret must FAIL CLOSED (throw at stack-eval) rather
 *     than silently boot on the committed dev key and ship forgeable sessions.
 */

/**
 * The fixed dev fallback secret. Non-secret by design: it only ever signs
 * sessions on the offline dev loop / the Vitest harness, never on a real deploy
 * (a real deploy with no `BETTER_AUTH_SECRET` throws before this is used).
 */
export const DEV_BETTER_AUTH_SECRET = "phoenix-dev-secret-not-for-production";

/** The subset of the deploy-time process env this resolver reads. */
export interface DeployEnvInput {
	readonly ENVIRONMENT?: string | undefined;
	readonly BETTER_AUTH_SECRET?: string | undefined;
	readonly CI?: string | undefined;
	readonly VITEST?: string | undefined;
}

/** The safety-critical env fields the worker block resolves at deploy time. */
export interface ResolvedDeployEnv {
	readonly ENVIRONMENT: string;
	readonly BETTER_AUTH_SECRET: string;
}

/**
 * Is this the offline/dev path — `alchemy dev` or the Vitest integration
 * harness — where the dev defaults are safe?
 *
 * Keyed off explicit signals, not bare `process.env.CI` truthiness: `CI` must be
 * the literal string `"true"` to count as CI, and `VITEST` (the test harness)
 * always wins. So `CI="false"` is the dev path, and CI's test job (which sets
 * both `CI=true` and `VITEST`) stays on the dev path too — only a real
 * `alchemy deploy` (CI, no Vitest) is treated as a real deploy.
 */
const isDevPath = (env: DeployEnvInput): boolean => env.CI !== "true" || env.VITEST === "true";

/**
 * Resolve the deploy-time env, failing closed on a real deploy.
 *
 * Pure over an injected snapshot so the fail-closed branch is unit-testable
 * without mutating the real `process.env`.
 *
 * @throws when a real deploy (CI, non-Vitest) provides no `BETTER_AUTH_SECRET`.
 */
export const resolveDeployEnv = (env: DeployEnvInput): ResolvedDeployEnv => {
	const ENVIRONMENT = env.ENVIRONMENT ?? "development";

	if (env.BETTER_AUTH_SECRET) {
		return {ENVIRONMENT, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET};
	}

	if (isDevPath(env)) {
		return {ENVIRONMENT, BETTER_AUTH_SECRET: DEV_BETTER_AUTH_SECRET};
	}

	throw new Error(
		"BETTER_AUTH_SECRET is unset on a real deploy. Refusing to fall back to the " +
			"committed dev secret (that would ship forgeable sessions). Set BETTER_AUTH_SECRET " +
			"in the deploy environment (CI secret or --env-file/.env).",
	);
};
