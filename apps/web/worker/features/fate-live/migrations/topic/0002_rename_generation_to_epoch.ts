/**
 * Rename `subscribers.generation` to `epoch`.
 *
 * The instance code (`live-instance.ts`) reads/writes the column as `epoch`;
 * `0001` created it as `generation` (the legacy column name from the original
 * `cloudflare:workers` DO). This migration brings the schema in line with the
 * code without rewriting history.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql`ALTER TABLE subscribers RENAME COLUMN generation TO epoch`,
);
