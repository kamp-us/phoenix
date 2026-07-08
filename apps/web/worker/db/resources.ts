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
import {devDatabaseName} from "../env.ts";

/**
 * The single D1 database — canonical store for every product table (ADR 0009,
 * d1-direct). `migrationsTable: "drizzle_migrations"` matches drizzle-kit's own
 * table name so the applied-set bookkeeping stays compatible; alchemy applies
 * pending migrations on deploy.
 *
 * `name` is set to a stable, stage-derived value **only on the local-state dev
 * path** (`devDatabaseName`, #2361): a fresh state store (new worktree / deleted
 * `.alchemy/`) then re-adopts the same dev D1 instead of minting a cloud orphan.
 * It stays `undefined` on every hosted-state path so production's auto-generated
 * physical name is unchanged and alchemy's D1 diff produces no replace — the why
 * (and the replace hazard) lives at `devDatabaseName`'s docblock.
 */
const devName = devDatabaseName(process.env);

export const PhoenixDb = Cloudflare.D1.Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
	// Spread rather than `name: devName`: under `exactOptionalPropertyTypes` an
	// explicit `undefined` is not assignable to `name?: string`, and omitting the
	// key entirely is exactly the "auto-generate" path prod must keep.
	...(devName ? {name: devName} : {}),
});
