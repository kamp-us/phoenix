/**
 * The worker's `effect/Config` surface — see `.patterns/worker-environment-pattern.md`.
 * The deploy-time state-store selector deliberately stays in `env.ts`: it runs in the
 * alchemy CLI process, a different moment from these runtime reads.
 */
import * as Config from "effect/Config";
import {DEFAULT_ENVIRONMENT, ENVIRONMENTS, type Environment} from "./environment.ts";

/**
 * The one home for the worker env binding NAMES (#1432): both halves of the bind↔read
 * seam reference these, so key↔name drift is unrepresentable rather than merely caught.
 * The CI-provisioned secret roster is duplicated in `infra/ci-credentials/github.ts`
 * because GitHub Actions and turbo can't import TS.
 */
export const ENV_BINDINGS = {
	environment: "ENVIRONMENT",
	betterAuthSecret: "BETTER_AUTH_SECRET",
	sentryDsn: "SENTRY_DSN",
} as const;

/**
 * The deploy environment (ADR 0088; taxonomy owned by `environment.ts`). The
 * `withDefault` is deliberate and fail-closed: an unset var reads "production", closing
 * every dev gate. It cannot mask a name typo — `ENV_BINDINGS.environment` leaves no
 * second literal to drift — and an unknown value still fails loud at the deploy gate.
 */
export const environment = Config.literals(ENVIRONMENTS, ENV_BINDINGS.environment).pipe(
	Config.withDefault(DEFAULT_ENVIRONMENT),
);

export type {Environment};

/**
 * The better-auth session-signing secret. It must travel as a binding, NOT via
 * `alchemy/Random`: `Random` is a deploy-time resource with no value in the workerd
 * isolate (`SECRET.text` is `undefined` there), so it could never be read back at request
 * time. No default, so a missing secret fails closed instead of signing with a blank key.
 */
export const betterAuthSecret = Config.redacted(ENV_BINDINGS.betterAuthSecret);

/**
 * The Sentry DSN (ADR 0118). Deliberately absent from `envBindings` below: `index.ts`
 * adds the binding only when a DSN is provisioned, so an unset DSN produces no binding
 * and `Config.option` resolves `None`, leaving the Sentry path inert. Read as a plain
 * string (not redacted) because workerd exposes it as one and it is handed verbatim to
 * `@sentry/cloudflare`.
 */
export const sentryDsn = Config.string(ENV_BINDINGS.sentryDsn).pipe(Config.option);

// Spread into the `env:` block in `index.ts`, so binding names are never restated there.
export const envBindings = {
	[ENV_BINDINGS.environment]: environment,
	[ENV_BINDINGS.betterAuthSecret]: betterAuthSecret,
};

export const AppConfig = Config.all({environment});
