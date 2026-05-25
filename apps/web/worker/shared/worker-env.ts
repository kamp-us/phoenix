/**
 * The worker's typed env representation and the gates derived from it.
 *
 * `worker/index.ts` assembles the worker `env` from two sources — the alchemy
 * runtime `WorkerEnvironment` (an untyped `Record<string, any>` of the
 * deploy-declared vars + the asset/DO bindings) and the bound D1 client
 * (`PHOENIX_DB`, surfaced from `db.raw` for better-auth's drizzle adapter).
 * Historically that assembled value was double-cast — `... as unknown as Env`,
 * then read back through `(env as unknown as Record<string, unknown>)` to derive
 * the admin gate. That cast-laundering is what let the prod-gate bug (the admin
 * seeders opening in production) slip past the type checker.
 *
 * {@link WorkerEnv} is that assembled value, typed: the runtime env record
 * overlaid with the two fields `index.ts` knows precisely — the injected
 * `PHOENIX_DB` (`Env`'s `D1Database`) and `ENVIRONMENT` typed as `string`. The
 * deploy-time resolver (`shared/deploy-env.ts`) yields a real `string`
 * (`"production"` on a real deploy), so the `"development"` literal the
 * wrangler-generated `Env` declares is too narrow to model the gate — widening
 * it here makes {@link adminAllowed} a typed `string` comparison the checker can
 * actually see, instead of a comparison against an always-true-on-paper literal.
 */

/**
 * The worker's assembled env. The untyped alchemy runtime env record overlaid
 * with the two fields the worker injects/reads with precision: `PHOENIX_DB` (the
 * bound D1 client, typed as `Env`'s binding) and `ENVIRONMENT` honestly typed as
 * `string`. The remaining bindings (`ASSETS`, the DO namespaces, the
 * `BETTER_AUTH_*` vars) stay on the runtime record's index signature — alchemy
 * provides them at runtime but does not type them per-key.
 */
export type WorkerEnv = Record<string, unknown> & {
	readonly PHOENIX_DB: Env["PHOENIX_DB"];
	/**
	 * The deploy-resolved environment (`shared/deploy-env.ts`). `string`, not the
	 * `"development"` literal the generated `Env` declares: a real deploy sets
	 * `"production"`, and the admin gate must be able to observe that.
	 */
	readonly ENVIRONMENT: string;
};

/**
 * Does this env open the dev-only surfaces (the `/api/admin/*` seeder + clear
 * routes)? The single gate — open only on a `development` environment, closed by
 * default (fail-closed) for every real-deploy environment. A typed read off
 * {@link WorkerEnv}, no `Record` cast.
 */
export const adminAllowed = (env: WorkerEnv): boolean => env.ENVIRONMENT === "development";
