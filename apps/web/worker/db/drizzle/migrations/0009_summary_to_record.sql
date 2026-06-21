-- #1041 — rename the last two D1 stores of record off the projection-era
-- `*_summary` name onto the `*_record` name. Under d1-direct (ADR 0009) there is
-- no projection layer: `term_summary`/`post_summary` are authoritative MUTATED
-- stores, not derived read-models, so the `_summary` suffix lied — a reader sees
-- `post_summary` and assumes it's safe to rebuild from a source of truth, but
-- deleting a row destroys the post. #853 already renamed the other two
-- (`definition_view`/`comment_view` → `*_record`); this completes the set so all
-- four canonical stores read uniformly as stores of record.
--
-- DATA-PRESERVING by construction: `ALTER TABLE ... RENAME TO` keeps every row;
-- there is NO drop-and-recreate (a botch here is data loss). SQLite carries the
-- existing indexes onto the renamed table but keeps their OLD names and has no
-- `RENAME INDEX`, so each index is DROP'd and re-CREATE'd under its new name on
-- the renamed table — same columns, same shape (the partial UNIQUE one-draft
-- guard keeps its `WHERE is_draft = 1` predicate).

ALTER TABLE `term_summary` RENAME TO `term_record`;--> statement-breakpoint
ALTER TABLE `post_summary` RENAME TO `post_record`;--> statement-breakpoint
DROP INDEX `term_summary_recent`;--> statement-breakpoint
DROP INDEX `term_summary_popular`;--> statement-breakpoint
DROP INDEX `term_summary_letter`;--> statement-breakpoint
DROP INDEX `post_summary_hot`;--> statement-breakpoint
DROP INDEX `post_summary_new`;--> statement-breakpoint
DROP INDEX `post_summary_top`;--> statement-breakpoint
DROP INDEX `post_summary_discuss`;--> statement-breakpoint
DROP INDEX `post_summary_host`;--> statement-breakpoint
DROP INDEX `post_summary_author_created`;--> statement-breakpoint
DROP INDEX `post_summary_one_draft_per_author`;--> statement-breakpoint
CREATE INDEX `term_record_recent` ON `term_record` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `term_record_popular` ON `term_record` (`total_score`);--> statement-breakpoint
CREATE INDEX `term_record_letter` ON `term_record` (`first_letter`);--> statement-breakpoint
CREATE INDEX `post_record_hot` ON `post_record` (`hot_score`);--> statement-breakpoint
CREATE INDEX `post_record_new` ON `post_record` (`created_at`);--> statement-breakpoint
CREATE INDEX `post_record_top` ON `post_record` (`score`);--> statement-breakpoint
CREATE INDEX `post_record_discuss` ON `post_record` (`comment_count`);--> statement-breakpoint
CREATE INDEX `post_record_host` ON `post_record` (`host`);--> statement-breakpoint
CREATE INDEX `post_record_author_created` ON `post_record` (`author_id`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `post_record_one_draft_per_author` ON `post_record` (`author_id`) WHERE `is_draft` = 1;
