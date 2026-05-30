/**
 * The worker's assembled env. The untyped alchemy runtime env record overlaid
 * with the two fields the worker injects/reads with precision: `PHOENIX_DB` (the
 * bound D1 client) and `ENVIRONMENT` typed as `string` (the deploy-resolved
 * environment, widened from the generated `Env`'s `"development"` literal so the
 * admin gate is a real string comparison).
 */
export type WorkerEnv = Record<string, unknown> & {
	readonly PHOENIX_DB: Env["PHOENIX_DB"];
	readonly ENVIRONMENT: string;
};

/**
 * Does this env open the dev-only surfaces (the `/api/admin/*` seeder + clear
 * routes)? Fail-closed: open only when `ENVIRONMENT === "development"`.
 */
export const adminAllowed = (env: WorkerEnv): boolean => env.ENVIRONMENT === "development";
