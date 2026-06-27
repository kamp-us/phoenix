/**
 * Resource declarations shared between the alchemy stack (`alchemy.run.ts`) and
 * the worker (`worker/index.ts`): the stack ensures the resource exists before
 * deploy, the worker `bind()`s it at runtime. Replaces the `wrangler.jsonc`
 * `d1_databases` / `migrations_dir` keys (ADR 0026).
 *
 * Owns the D1 store and the imge R2 object store. The Flagship flag-IaC surface
 * lives beside its evaluator in `features/flagship/resources.ts`.
 */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The single D1 database — canonical store for every product table (ADR 0009,
 * d1-direct). `migrationsTable: "drizzle_migrations"` matches drizzle-kit's own
 * table name so the applied-set bookkeeping stays compatible; alchemy applies
 * pending migrations on deploy.
 */
export const PhoenixDb = Cloudflare.D1Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
});

/**
 * The imge object store — the system of record for all imge media (ADR 0044
 * Decision 1). Bytes live here; per-object metadata lives in D1. Declared as a
 * worker binding (the `Cloudflare.R2Bucket.bind` pattern mirroring `PhoenixDb`),
 * provisioned by alchemy on deploy and resolved through the `MediaStore` seam
 * (`db/MediaStore.ts`). This is the binding only — keys, custom delivery domain,
 * and upload path land in later imge children (#109/#111).
 */
export const ImgeBucket = Cloudflare.R2Bucket("imge_objects");
