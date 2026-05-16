-- 0007 — pano comments on D1 (d1-direct/task_8).
-- `comment_view` becomes the canonical store for comments: add a full-text
-- `body` column (the per-post DO previously held the canonical body; the
-- view only carried `body_excerpt`) and a `parent_id` column so the comment
-- thread is reconstructable without round-tripping through the per-post DO.
-- New `comment_vote` table replaces the per-post DO `comment_vote` storage
-- for the up-only MVP vote primitive. Mirrors `definition_vote` (task_5)
-- and `post_vote` (task_7).
ALTER TABLE `comment_view` ADD `body` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `comment_view` ADD `parent_id` text;--> statement-breakpoint
CREATE TABLE `comment_vote` (
	`comment_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`comment_id`, `voter_id`)
);--> statement-breakpoint
CREATE INDEX `comment_vote_comment` ON `comment_vote` (`comment_id`);--> statement-breakpoint
CREATE INDEX `comment_view_post` ON `comment_view` (`post_id`);--> statement-breakpoint
CREATE INDEX `comment_view_parent` ON `comment_view` (`parent_id`);
