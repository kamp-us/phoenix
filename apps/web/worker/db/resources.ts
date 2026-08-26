/**
 * Resource declarations shared between the alchemy stack and the worker: the stack
 * ensures the resource exists before deploy, the worker `bind()`s it at runtime
 * (ADR 0026). Owns only the D1 store; Flagship's IaC lives with its evaluator.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {devDatabaseName, migrationsDriftStrategy} from "../env.ts";

/**
 * The single D1 database (ADR 0009). `migrationsTable` must match drizzle-kit's own
 * table name so the applied-set bookkeeping stays compatible.
 *
 * `name` is stage-derived only on the local-state dev path, so a fresh state store
 * re-adopts the same dev D1 instead of minting a cloud orphan. It stays `undefined` on
 * hosted state — see `devDatabaseName`'s docblock for the replace hazard.
 */
const devName = devDatabaseName(process.env);
const driftStrategy = migrationsDriftStrategy(process.env);

export const PhoenixDb = Cloudflare.D1.Database("phoenix_db", {
	migrationsDir: "./worker/db/drizzle/migrations",
	migrationsTable: "drizzle_migrations",
	// Spread rather than `name: devName`: under `exactOptionalPropertyTypes` an
	// explicit `undefined` is not assignable to `name?: string`, and omitting the
	// key entirely is exactly the "auto-generate" path prod must keep.
	...(devName ? {name: devName} : {}),
	// `D1_MIGRATIONS_DRIFT=adopt` on a deploy is the operator's answer to the patched
	// resource's migration-drift refusal (ADR 0309 amendment, #7055); same spread rule.
	...(driftStrategy ? {migrationsDriftStrategy: driftStrategy} : {}),
});
