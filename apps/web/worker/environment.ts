/**
 * The deploy-environment taxonomy (ADR 0088) and the predicates the IaC, CI and
 * runtime share — one owner for the classes, the `stage → ENVIRONMENT` map and the
 * production gate, because five sites once re-derived them and a `prod`≠`production`
 * drift failed OPEN on a green deploy (#1433).
 *
 * Deliberately pure, with no `effect` import: this is read at three moments — by the
 * worker runtime through `config.ts`, by the alchemy CLI over `process.env` at deploy
 * time, and by `deploy.yml` running `environmentForStage` directly under node. An
 * Effect dependency would bind it to the runtime moment alone.
 */

// `audit` is the rite-audit harness's isolated deployed stage (#1511): a force-on
// targeting rule can serve a dark-ship flag there without ever reaching production. It
// is not production, so it provisions no email subdomain or apex domain.
export const ENVIRONMENTS = ["development", "preview", "production", "audit"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

// Single-sourced so `environmentForStage` and any audit force-on targeting rule name
// the same literal.
export const AUDIT_ENVIRONMENT: Environment = "audit";

export const AUDIT_STAGE = "audit";

// Fail-closed: a missing `ENVIRONMENT` lands in production and closes every dev gate.
export const DEFAULT_ENVIRONMENT: Environment = "production";

export const isEnvironment = (value: string): value is Environment =>
	(ENVIRONMENTS as readonly string[]).includes(value);

// Fail loud rather than downgrade (ADR 0092): an unrecognized value used to fall
// through to non-prod, so a green deploy silently provisioned nothing (#1433).
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

// Absent stays `undefined` so the caller picks the default — a local `alchemy deploy`
// with no `ENVIRONMENT` must still read as non-prod.
export const parseDeployEnvironment = (value: string | undefined): Environment | undefined => {
	if (value === undefined || value === "") return undefined;
	if (isEnvironment(value)) return value;
	throw new UnknownEnvironmentError(value);
};

export const isProduction = (environment: Environment): boolean => environment === "production";

export const isProductionDeploy = (env: {readonly ENVIRONMENT?: string | undefined}): boolean => {
	const environment = parseDeployEnvironment(env.ENVIRONMENT);
	return environment !== undefined && isProduction(environment);
};

// The single owner of the `prod`→`production` spelling; `deploy.yml` calls this under
// node rather than inlining the mapping in YAML (#1433). Only `prod` maps to
// `production`, which is what keeps the audit force-on rule from matching a prod deploy.
export const environmentForStage = (stage: string): Environment =>
	stage === "prod" ? "production" : stage === AUDIT_STAGE ? "audit" : "preview";
