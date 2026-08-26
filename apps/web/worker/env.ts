/**
 * The deploy-time state-store selector (`resolveStateMode`/`isOfflinePath`),
 * which runs in the alchemy CLI process over `process.env` — the *deploy-time*
 * environment, not the worker runtime. `alchemy.run.ts` calls it before any
 * worker env is bound, which is why it lives here rather than as an
 * `effect/Config` constant in `config.ts` (it has no `Config` equivalent).
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {isProductionDeploy} from "./environment.ts";

/**
 * The blob is an untyped trust boundary (a CLI-set env-var JSON string), so it is
 * decoded here rather than asserted with a cast.
 *
 * @see node_modules/alchemy/lib/Cli/commands/deploy.js — `ExecStackOptions`
 */
const ExecOptions = Schema.Struct({
	dev: Schema.optional(Schema.Unknown),
	stage: Schema.optional(Schema.Unknown),
});
// `fromJsonString` parses the blob AND decodes it in one step, folding a JSON
// parse failure into a `None` — so a malformed blob needs no raw `try/catch`.
const decodeExecOptions = Schema.decodeUnknownOption(Schema.fromJsonString(ExecOptions));

export interface DeployEnvInput {
	readonly ENVIRONMENT?: string | undefined;
	readonly CI?: string | undefined;
	/**
	 * Set only by `alchemy dev` in its exec subprocess; `deploy`/`plan`/`destroy` run
	 * inline and never set it. So a parsed `dev: true` is the genuine dev signal.
	 *
	 * @see node_modules/alchemy/lib/Cli/commands/dev.js — sets `ALCHEMY_EXEC_OPTIONS`
	 */
	readonly ALCHEMY_EXEC_OPTIONS?: string | undefined;
	/**
	 * A coarser dev override alchemy's test harness honors; treated as a dev signal for parity.
	 *
	 * @see node_modules/alchemy/lib/Test/Core.js — `resolveDev`
	 */
	readonly ALCHEMY_DEV?: string | undefined;
	/**
	 * The operator's "adopt" answer to a D1 migration-drift refusal (#7055, ADR 0309
	 * amendment). Read by `migrationsDriftStrategy` below; only the literal `adopt` counts.
	 */
	readonly D1_MIGRATIONS_DRIFT?: string | undefined;
}

export type StateMode = "local" | "cloudflare";

/**
 * Keyed off the genuine dev signal alone, NOT `CI` and NOT `VITEST`. `CI` is set for both
 * the deploy workflow and the integration-test job, so it cannot tell a real deploy from a
 * test run; and since ADR 0082 the integration suite deploys to real remote Cloudflare, so
 * a Vitest run must resolve to the shared store exactly like a deploy.
 */
const isOfflinePath = (env: DeployEnvInput): boolean => {
	const devOverride = env.ALCHEMY_DEV?.toLowerCase();
	if (devOverride === "1" || devOverride === "true") return true;

	if (env.ALCHEMY_EXEC_OPTIONS) {
		// A malformed blob decodes to `None`, so it is not a dev signal — fall through to
		// deploy. Failing safe toward the shared store keeps collab/diff intact.
		const parsed = decodeExecOptions(env.ALCHEMY_EXEC_OPTIONS);
		if (Option.isSome(parsed) && parsed.value.dev === true) return true;
	}

	return false;
};

// Pure over an injected snapshot so the selector is unit-testable without mutating the
// real `process.env`.
export const resolveStateMode = (env: DeployEnvInput): StateMode =>
	isOfflinePath(env) ? "local" : "cloudflare";

/**
 * A missing stage must NOT pin a name: a stage-less name would collide across personal
 * stages (stage is the isolation unit, ADR 0057). No stage ⇒ fall back to alchemy's
 * auto-generated per-instance name.
 */
export const resolveDevStage = (env: DeployEnvInput): string | undefined => {
	if (!isOfflinePath(env) || !env.ALCHEMY_EXEC_OPTIONS) return undefined;
	// Malformed blob → `None` → no stage → auto-name (matches resolveStateMode's fail-safe).
	const parsed = decodeExecOptions(env.ALCHEMY_EXEC_OPTIONS);
	if (Option.isSome(parsed) && typeof parsed.value.stage === "string" && parsed.value.stage) {
		return parsed.value.stage;
	}
	return undefined;
};

/**
 * A stable, stage-derived D1 name for the **local-state dev path only**, so a fresh state
 * store re-adopts the same dev D1 instead of minting a cloud orphan (#2361).
 *
 * Returning `undefined` on every hosted-state path is the load-bearing safety constraint:
 * an existing tracked D1's `diff` returns `{action:"replace"}` when the desired name
 * differs from the persisted one, so an *unconditional* name would replace the production
 * D1 with an empty database. Production's `name` stays `undefined`, so its diff resolves
 * the name from the persisted `output.databaseName` — byte-identical, no replace (verified
 * in the pinned alchemy `DatabaseProvider.diff`).
 */
export const devDatabaseName = (env: DeployEnvInput): string | undefined => {
	const stage = resolveDevStage(env);
	if (!stage) return undefined;
	return `phoenix-phoenix_db-${stage}`.replaceAll(/[^a-zA-Z0-9-]/g, "-");
};

/**
 * The patched `D1.Database` (ADR 0038, #7055) refuses a deploy whose recorded migration ids
 * no longer match the on-disk files, naming adopt-or-wipe as the ways out. This resolves the
 * operator's per-run "adopt" consent from the deploy environment: only the literal `adopt`
 * re-keys content-identical renames without re-running their SQL; anything else keeps the
 * refuse default. Pure over an injected snapshot, like `resolveStateMode` above.
 */
export const migrationsDriftStrategy = (env: DeployEnvInput): "adopt" | undefined =>
	env.D1_MIGRATIONS_DRIFT === "adopt" ? "adopt" : undefined;

export const PHOENIX_APEX_HOSTNAME = "phoenix.kamp.us" as const;

/**
 * PRODUCTION-ONLY. Every non-prod deploy gets no custom domain, so its `worker.url` stays
 * the `*.workers.dev` preview URL. The prod test is the shared `isProductionDeploy`
 * predicate (ADR 0088), never a copied `=== "production"`. The `stage` arg is unused, kept
 * for call-site symmetry — there is deliberately NO `<stage>.phoenix.kamp.us` subdomain.
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
): string | undefined =>
	isProductionDeploy({ENVIRONMENT: environment}) ? PHOENIX_APEX_HOSTNAME : undefined;
