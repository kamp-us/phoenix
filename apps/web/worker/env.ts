/**
 * The deploy-time state-store selector (`resolveStateMode`/`isOfflinePath`),
 * which runs in the alchemy CLI process over `process.env` — the *deploy-time*
 * environment, not the worker runtime. `alchemy.run.ts` calls it before any
 * worker env is bound, which is why it lives here rather than as an
 * `effect/Config` constant in `config.ts` (it has no `Config` equivalent).
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The one field of alchemy's `ALCHEMY_EXEC_OPTIONS` blob the selector reads. The
 * blob is an untyped trust boundary (a CLI-set env-var JSON string), so it's
 * decoded at the boundary rather than asserted with a cast.
 */
const ExecOptions = Schema.Struct({dev: Schema.optional(Schema.Unknown)});
const decodeExecOptions = Schema.decodeUnknownOption(ExecOptions);

/** The subset of the deploy-time process env the selector reads. */
export interface DeployEnvInput {
	readonly ENVIRONMENT?: string | undefined;
	readonly CI?: string | undefined;
	/**
	 * The alchemy `dev` flag, set only by `alchemy dev` (the offline workerd loop)
	 * in its exec subprocess; `deploy`/`plan`/`destroy` run inline and never set
	 * it. So a parsed `dev: true` is the genuine dev signal, readable synchronously
	 * at module-eval before any `AlchemyContext` is in scope.
	 *
	 * @see node_modules/alchemy/lib/Cli/commands/dev.js — sets `ALCHEMY_EXEC_OPTIONS`
	 */
	readonly ALCHEMY_EXEC_OPTIONS?: string | undefined;
	/**
	 * A coarser dev override (`"1"`/`"true"`) alchemy's test harness honors; treated
	 * as a dev signal here for parity.
	 *
	 * @see node_modules/alchemy/lib/Test/Core.js — `resolveDev`
	 */
	readonly ALCHEMY_DEV?: string | undefined;
}

/** Which alchemy state store the stack should use. */
export type StateMode = "local" | "cloudflare";

/**
 * Is this an offline alchemy path (`alchemy dev`) where file-based `localState()`
 * is required?
 *
 * Keyed off the genuine dev signal alone, NOT `CI` and NOT `VITEST`. `CI` is set
 * for both the deploy workflow and the integration-test job, so it can't tell a
 * real deploy from a test run. `VITEST` is no longer an offline signal either:
 * since ADR 0082 the integration suite deploys to **real remote Cloudflare** via
 * `Test.make` (real D1, real state), so a Vitest run must resolve to the shared
 * Cloudflare store, exactly like a real deploy. Only `alchemy dev` — its `dev`
 * flag in `ALCHEMY_EXEC_OPTIONS` (`deploy` runs inline and never sets it), or the
 * coarser `ALCHEMY_DEV` override `Test.make` honors — is the offline path.
 */
const isOfflinePath = (env: DeployEnvInput): boolean => {
	const devOverride = env.ALCHEMY_DEV?.toLowerCase();
	if (devOverride === "1" || devOverride === "true") return true;

	if (env.ALCHEMY_EXEC_OPTIONS) {
		try {
			const parsed = decodeExecOptions(JSON.parse(env.ALCHEMY_EXEC_OPTIONS));
			if (Option.isSome(parsed) && parsed.value.dev === true) return true;
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

/** The apex the phoenix worker is served under (a Cloudflare Custom Domain). */
export const PHOENIX_APEX_HOSTNAME = "phoenix.kamp.us" as const;

/**
 * The Cloudflare Custom Domain hostname the worker is served at (issue #594) —
 * PRODUCTION-ONLY. A production deploy serves the apex `phoenix.kamp.us`; every
 * non-prod deploy (ephemeral integration `it-*` stages, preview stages, named dev
 * stages) gets **no** custom domain (`undefined`), so its `worker.url` stays the
 * `*.workers.dev` preview URL.
 *
 * The prod test is the `ENVIRONMENT` literal — a deploy is production iff
 * `environment === "production"`, the same fail-closed gate the email IaC uses
 * (`isProductionDeploy`), independent of the stage name. The `stage` arg is unused
 * (kept for call-site symmetry / future named-stage domains) — there is deliberately
 * NO `<stage>.phoenix.kamp.us` per-stage subdomain anymore.
 *
 * Why production-only and not per-stage: #594's AC asked for `<stage>.phoenix.kamp.us`
 * per non-prod stage "so isolated deploys don't collide on the apex", but that itself
 * was a bug. Attaching a custom domain to an ephemeral integration `Test.make` stage
 * binds a hostname whose TLS cert isn't provisioned yet, so the integration harness's
 * `GET <worker.url>/api/health` dies on an SSL handshake failure — it broke every
 * integration test. The apex-collision the per-stage subdomain avoided is MOOT now:
 * non-prod stages have no domain at all, so they cannot collide on the apex. A
 * long-lived named stage that ever needs its own domain is a deliberate future
 * addition, not an ephemeral-stage default (engineering-led per ADR 0078).
 */
export const customHostname = (
	// biome-ignore lint/correctness/noUnusedFunctionParameters: kept for call-site symmetry; see docblock
	stage: string,
	environment: string,
): string | undefined => (environment === "production" ? PHOENIX_APEX_HOSTNAME : undefined);
