/**
 * Initial schema for `TopicDO`'s durable subscriber registry.
 *
 * One row per (connectionId, subId) pair: the connection holding the SSE stream
 * and the live subscription opened on it. `generation` was the legacy name for
 * what subsequent code calls `epoch` (the connection's stream lifetime counter
 * at register time) — renamed in `0002` so the migration history stays honest
 * and append-only.
 *
 * `IF NOT EXISTS` is load-bearing for the production cutover: legacy TopicDOs
 * already have this table (without the `effect_sql_migrations` ledger), so
 * `CREATE TABLE` would crash on first wake after deploy. With `IF NOT EXISTS`
 * the migrator no-ops on existing tables, records `0001` as applied, then runs
 * `0002` (the rename) on top — converging fresh and legacy DOs onto `epoch`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.flatMap(
	SqlClient.SqlClient,
	(sql) =>
		sql`CREATE TABLE IF NOT EXISTS subscribers (
			connectionId TEXT NOT NULL,
			subId TEXT NOT NULL,
			generation INTEGER NOT NULL,
			updatedAt INTEGER NOT NULL,
			misses INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (connectionId, subId)
		)`,
);
