ALTER TABLE `post_summary` ADD `is_draft` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `post_summary_one_draft_per_author` ON `post_summary` (`author_id`) WHERE `is_draft` = 1;