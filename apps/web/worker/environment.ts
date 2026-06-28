/**
 * The deploy-environment taxonomy (ADR 0088) and the predicates the IaC↔CI↔runtime
 * seam shares — the ONE module owning `development | preview | production`, the
 * `stage → ENVIRONMENT` map (the `prod`→`production` spelling), and the fail-closed
 * `isProduction` gate. Before #1433 these were re-derived independently at five sites
 * (deploy.yml, config.ts, email-resources.ts, env.ts, alchemy.run.ts) with no shared
 * predicate, so a `prod`≠`production` drift would fail OPEN: every gate falling through
 * to non-prod on a *green* deploy (no email subdomain, no apex domain, no error).
 *
 * Pure — no `effect` import — on purpose: this contract is read at THREE distinct
 * moments and must not be tied to any one of them. The worker runtime reads it via the
 * `effect/Config` surface in `config.ts`; the alchemy CLI reads it over `process.env`
 * at deploy time; and `.github/workflows/deploy.yml` runs `environmentForStage` directly
 * under node (which strips the types). An Effect dependency here would bind it to the
 * runtime moment alone.
 */

/** The three deploy classes (ADR 0088), as the canonical literal tuple every site reuses. */
export const ENVIRONMENTS = ["development", "preview", "production"] as const;

/** The deploy environment — one of the three classes (ADR 0088). */
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The fail-closed default when `ENVIRONMENT` is unset at runtime (ADR 0088): a missing
 * var lands in production, closing every dev gate. `config.ts` binds this as the
 * `Config.withDefault`.
 */
export const DEFAULT_ENVIRONMENT: Environment = "production";

/** Is `value` one of the taxonomy's three classes? */
export const isEnvironment = (value: string): value is Environment =>
	(ENVIRONMENTS as readonly string[]).includes(value);

/**
 * Thrown when a non-empty `ENVIRONMENT` value is outside the taxonomy — the fail-LOUD
 * guard (#1433). Before this, an unrecognized value (the stage spelling `prod` instead
 * of `production`, say) silently fell through to non-prod, so a green deploy provisioned
 * no email subdomain and no apex domain. Failing loud here is the fail-closed posture of
 * ADR 0092 applied to the env taxonomy: refuse rather than silently downgrade.
 */
export class UnknownEnvironmentError extends Error {
	readonly value: string;
	constructor(value: string) {
		super(
			`Unknown ENVIRONMENT "${value}" — not one of ${ENVIRONMENTS.join(" | ")} (ADR 0088). ` +
				"Refusing to fail open to non-production (#1433).",
		);
		this.name = "UnknownEnvironmentError";
		this.value = value;
	}
}

/**
 * Parse a deploy-time `ENVIRONMENT` string into a typed `Environment`.
 *
 * - unset / empty → `undefined`: genuinely absent, so the caller decides the default.
 *   The deploy gates read absence as non-prod, preserving the prior `=== "production"`
 *   behavior for a local `alchemy deploy` with no `ENVIRONMENT`.
 * - a known class → that `Environment`.
 * - a non-empty UNKNOWN value → throws `UnknownEnvironmentError` (fail loud, #1433).
 */
export const parseDeployEnvironment = (value: string | undefined): Environment | undefined => {
	if (value === undefined || value === "") return undefined;
	if (isEnvironment(value)) return value;
	throw new UnknownEnvironmentError(value);
};

/** The fail-closed production gate over a typed `Environment` — the ONE predicate every TS gate shares. */
export const isProduction = (environment: Environment): boolean => environment === "production";

/**
 * Is this a production deploy? Reads the deploy-time `process.env.ENVIRONMENT` (the same
 * var the worker's `Config` binds at runtime). Fail-closed: an absent value is non-prod,
 * and a non-empty unknown value throws rather than silently downgrading (#1433) — so a CI
 * misconfiguration (e.g. emitting `prod`) fails the deploy loudly instead of quietly
 * skipping the email subdomain and apex domain.
 */
export const isProductionDeploy = (env: {readonly ENVIRONMENT?: string | undefined}): boolean => {
	const environment = parseDeployEnvironment(env.ENVIRONMENT);
	return environment !== undefined && isProduction(environment);
};

/**
 * Map an alchemy stage name → its deploy `ENVIRONMENT` class — the single owner of the
 * `prod`→`production` spelling. `.github/workflows/deploy.yml` calls this (via node) so
 * the mapping lives here, not inlined in a YAML expression (#1433). The main-push stage
 * `prod` is `production`; every other stage (the per-PR `pr-<n>` previews, ephemeral
 * `it-*` integration stages) is `preview`. Local `alchemy dev` sets `development` via
 * `.env` and is never a deployed stage.
 */
export const environmentForStage = (stage: string): Environment =>
	stage === "prod" ? "production" : "preview";
