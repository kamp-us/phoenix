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
 * The two fields of alchemy's `ALCHEMY_EXEC_OPTIONS` blob we read: `dev` (the
 * offline signal) and `stage` (the deploy target, used to derive the dev D1's
 * stable name). The blob is an untyped trust boundary (a CLI-set env-var JSON
 * string), so it's decoded at the boundary rather than asserted with a cast.
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
		// A malformed blob decodes to `None`, so it's not a dev signal — fall through
		// to deploy (shared store). Failing safe toward the shared store keeps
		// collab/diff intact.
		const parsed = decodeExecOptions(env.ALCHEMY_EXEC_OPTIONS);
		if (Option.isSome(parsed) && parsed.value.dev === true) return true;
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

/**
 * The stage the local-state dev path is deploying to, read from the same
 * `ALCHEMY_EXEC_OPTIONS` blob the offline signal comes from (`alchemy dev`
 * always encodes its resolved `stage`, defaulting to `dev_${USER}`).
 *
 * `undefined` off the local dev path, and also `undefined` on a local path with
 * no decodable stage (the coarse `ALCHEMY_DEV`-only harness, or a malformed
 * blob) — a missing stage must NOT pin a name, since a stage-less name would
 * collide across personal stages (stage is the isolation unit, ADR 0057). No
 * stage ⇒ fall back to alchemy's auto-generated per-instance name (today's
 * behavior).
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
 * The explicit D1 physical name for the **local-state dev path only** — a
 * stable, stage-derived name so a fresh state store (a new worktree, a deleted
 * `.alchemy/`, a new machine) re-adopts the same dev D1 instead of minting a new
 * cloud orphan (#2361; adoption path grounded in `alchemy@2.0.0-beta.59`
 * `Cloudflare/D1/Database.js` `read` — `name ?? createPhysicalName({id})`).
 *
 * `undefined` on every hosted-state path (production, a real `alchemy deploy`,
 * the `Test.make` integration harness). This is the load-bearing safety
 * constraint: an existing tracked D1's `diff` returns `{action:"replace"}` when
 * the desired name differs from the persisted one, so an *unconditional* name
 * would replace the production D1 with an empty database. Because production's
 * `news.name` stays `undefined`, its diff still resolves the name from the
 * persisted `output.databaseName` — byte-identical, no replace (verified in the
 * pinned alchemy `DatabaseProvider.diff`).
 *
 * Mirrors alchemy's own `${stack}-${id}-${stage}` physical-name prefix
 * (`createPhysicalName`) minus the random per-instance suffix, sanitized to the
 * DNS-safe charset alchemy requires. The `phoenix`/`phoenix_db` literals mirror
 * the stack name (`alchemy.run.ts`) and the D1 logical id (`db/resources.ts`).
 */
export const devDatabaseName = (env: DeployEnvInput): string | undefined => {
	const stage = resolveDevStage(env);
	if (!stage) return undefined;
	return `phoenix-phoenix_db-${stage}`.replaceAll(/[^a-zA-Z0-9-]/g, "-");
};

/** The apex the phoenix worker is served under (a Cloudflare Custom Domain). */
export const PHOENIX_APEX_HOSTNAME = "phoenix.kamp.us" as const;

/**
 * The Cloudflare Custom Domain hostname the worker is served at (issue #594) —
 * PRODUCTION-ONLY. A production deploy serves the apex `phoenix.kamp.us`; every
 * non-prod deploy (ephemeral integration `it-*` stages, preview stages, named dev
 * stages) gets **no** custom domain (`undefined`), so its `worker.url` stays the
 * `*.workers.dev` preview URL.
 *
 * The prod test is the shared `isProductionDeploy` predicate owned by
 * `environment.ts` (ADR 0088) — the ONE gate every deploy/runtime site calls (#1433),
 * not a copied `=== "production"`. A deploy is production iff its `ENVIRONMENT` is the
 * `production` class, independent of the stage name. The `stage` arg is unused (kept for
 * call-site symmetry / future named-stage domains) — there is deliberately NO
 * `<stage>.phoenix.kamp.us` per-stage subdomain anymore.
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
