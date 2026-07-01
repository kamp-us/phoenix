/**
 * Resource declarations shared between the alchemy stack (`alchemy.run.ts`) and
 * the worker (`worker/index.ts`): the stack ensures the resource exists before
 * deploy, the worker `bind()`s it at runtime. Replaces the `wrangler.jsonc`
 * `d1_databases` / `migrations_dir` keys (ADR 0026).
 *
 * Owns only the D1 store. The Flagship flag-IaC surface lives beside its
 * evaluator in `features/flagship/resources.ts`.
 */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The single D1 database — canonical store for every product table (ADR 0009,
 * d1-direct). `migrationsTable: "drizzle_migrations"` matches drizzle-kit's own
 * table name so the applied-set bookkeeping stays compatible; alchemy applies
 * pending migrations on deploy.
 */
export const PhoenixDb = Cloudflare.D1.Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
});
