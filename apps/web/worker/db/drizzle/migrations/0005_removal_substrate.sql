-- ADR 0096 — the uniform removal substrate. Repurpose `deleted_at` as
-- `removed_at` on the three content tables, add the `removed_by` + `removed_reason`
-- audit columns, and backfill every existing soft-deleted row as
-- `Removed(AuthorDeletion)` with `removed_by = author_id` (best available actor).
-- Pano posts hard-deleted pre-substrate are gone and not reconstructable.

ALTER TABLE `definition_view` RENAME COLUMN `deleted_at` TO `removed_at`;--> statement-breakpoint
ALTER TABLE `definition_view` ADD `removed_by` text;--> statement-breakpoint
ALTER TABLE `definition_view` ADD `removed_reason` text;--> statement-breakpoint
ALTER TABLE `post_summary` RENAME COLUMN `deleted_at` TO `removed_at`;--> statement-breakpoint
ALTER TABLE `post_summary` ADD `removed_by` text;--> statement-breakpoint
ALTER TABLE `post_summary` ADD `removed_reason` text;--> statement-breakpoint
ALTER TABLE `comment_view` RENAME COLUMN `deleted_at` TO `removed_at`;--> statement-breakpoint
ALTER TABLE `comment_view` ADD `removed_by` text;--> statement-breakpoint
ALTER TABLE `comment_view` ADD `removed_reason` text;--> statement-breakpoint
UPDATE `definition_view` SET `removed_by` = `author_id`, `removed_reason` = '{"_tag":"AuthorDeletion"}' WHERE `removed_at` IS NOT NULL;--> statement-breakpoint
UPDATE `post_summary` SET `removed_by` = `author_id`, `removed_reason` = '{"_tag":"AuthorDeletion"}' WHERE `removed_at` IS NOT NULL;--> statement-breakpoint
UPDATE `comment_view` SET `removed_by` = `author_id`, `removed_reason` = '{"_tag":"AuthorDeletion"}' WHERE `removed_at` IS NOT NULL;
