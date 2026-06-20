/**
 * The read-side slice of the phoenix D1 schema this backfill scans —
 * `term_summary` / `post_summary`. These come from the `@kampus/db-schema` leaf
 * (the single canonical declaration the worker also re-exports), so this copy can
 * never drift from the real schema again (issue #859; the `deleted_at →
 * removed_at` rename that broke the old hand-copy now arrives by construction).
 * The backfill reads only a projection (`.slug`/`.id`/`.title`/`.removedAt`), but
 * importing the full canonical tables is the point — there is one declaration.
 * The leaf is a true leaf (only `drizzle-orm`), so depending on it adds no cycle
 * even though this package already prod-depends on `@kampus/web`.
 *
 * The *write* side is NOT here — the FTS upsert SQL is the worker's own
 * `syncTermSearch` / `syncPostSearch` (imported from `@kampus/web`), so the
 * indexed `norm` is byte-identical to the dual-write (issue #534's hard
 * constraint: same normalization, or backfilled rows won't match queries).
 */
import {postSummary, termSummary} from "@kampus/db-schema";

export {postSummary, termSummary};

export const backfillSchema = {termSummary, postSummary};
export type BackfillSchema = typeof backfillSchema;
