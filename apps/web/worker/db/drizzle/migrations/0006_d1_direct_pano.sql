-- 0006 — pano post on D1 (d1-direct/task_7).
-- `post_summary` becomes the canonical store for posts: add a full-text
-- `body` column (the per-post DO previously held the canonical body; the
-- view only carried `body_excerpt`). New `post_vote` table replaces the
-- per-post DO `post_vote` storage for the up-only MVP vote primitive.
ALTER TABLE `post_summary` ADD `body` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `post_vote` (
	`post_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `voter_id`)
);--> statement-breakpoint
CREATE INDEX `post_vote_post` ON `post_vote` (`post_id`);
