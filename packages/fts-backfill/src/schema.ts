/**
 * The read-side slice of the phoenix D1 schema this backfill scans —
 * `term_record` / `post_record`, imported from the canonical `@kampus/db-schema`
 * leaf so this copy can never drift from the real schema again (#859: the
 * `deleted_at → removed_at` rename that broke the old hand-copy now arrives by
 * construction). The leaf depends only on `drizzle-orm`, so importing it adds no
 * cycle.
 */
import {postRecord, termRecord} from "@kampus/db-schema";

export {postRecord, termRecord};

export const backfillSchema = {termRecord, postRecord};
export type BackfillSchema = typeof backfillSchema;
