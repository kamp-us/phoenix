-- #1109 — drop the vestigial `last_event_id` columns. They were the projection-era
-- convergent-overwrite guard (`WHERE last_event_id < excluded.last_event_id`),
-- unused under d1-direct (ADR 0009). Dropped from all five stores that carried it —
-- the four shared canonical stores plus the worker-private `user_profile` — so the
-- schema stays uniform (split off from #1041, which deferred this destructive drop to
-- keep the rename a pure data-preserving `ALTER TABLE RENAME`).
--
-- DESTRUCTIVE by construction: `DROP COLUMN` discards the column and its data. Safe as
-- a simple `ALTER TABLE ... DROP COLUMN` because no index or constraint references
-- `last_event_id` on any of these tables (SQLite/D1 reject a DROP COLUMN only when the
-- column is indexed or otherwise referenced; none of these are).

ALTER TABLE `term_record` DROP COLUMN `last_event_id`;--> statement-breakpoint
ALTER TABLE `definition_record` DROP COLUMN `last_event_id`;--> statement-breakpoint
ALTER TABLE `post_record` DROP COLUMN `last_event_id`;--> statement-breakpoint
ALTER TABLE `comment_record` DROP COLUMN `last_event_id`;--> statement-breakpoint
ALTER TABLE `user_profile` DROP COLUMN `last_event_id`;
