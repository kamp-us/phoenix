/**
 * Resource declarations shared between the alchemy stack (`alchemy.run.ts`) and
 * the worker (`worker/index.ts`). One definition, two consumers: the stack
 * ensures the resource exists before deploy; the worker `bind()`s it at runtime.
 *
 * This replaces the `d1_databases` / `migrations_dir` keys of `wrangler.jsonc`
 * (ADR 0026). The Durable Object namespaces are not declared here — they are the
 * `DurableObjectNamespace` classes themselves (`fate/connection-do.ts`,
 * `fate/topic-do.ts`); declaring + binding them in the worker is enough for
 * alchemy to derive their migrations.
 */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The single D1 database — the canonical store for every product table
 * (ADR 0009, d1-direct). `migrationsDir` points at the committed Drizzle
 * migration SQL; `migrationsTable: "drizzle_migrations"` keeps the applied-set
 * bookkeeping compatible with drizzle-kit's own table name. alchemy scans the
 * dir and applies pending migrations on deploy — replacing the
 * `wrangler d1 migrations apply` step.
 *
 * The cutover creates a *fresh* D1 (ADR 0009: phoenix has no irreplaceable prod
 * data; re-seed via the import scripts), so there is no adoption flag here.
 */
export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
});
