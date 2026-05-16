-- 0002 — drop NOT NULL on `user_profile.username` (NULL until bootstrap step)
-- and add `last_event_id` convergence guard for `UserProfileChanged` events.
-- SQLite can't ALTER COLUMN; rebuild via the standard 12-step __new_* dance.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP INDEX IF EXISTS `user_profile_username_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `user_profile_username`;--> statement-breakpoint
CREATE TABLE `__new_user_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text,
	`display_name` text,
	`image` text,
	`total_karma` integer DEFAULT 0 NOT NULL,
	`definition_count` integer DEFAULT 0 NOT NULL,
	`post_count` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`last_event_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user_profile`("user_id", "username", "display_name", "image", "total_karma", "definition_count", "post_count", "comment_count", "updated_at") SELECT "user_id", "username", "display_name", "image", "total_karma", "definition_count", "post_count", "comment_count", "updated_at" FROM `user_profile`;--> statement-breakpoint
DROP TABLE `user_profile`;--> statement-breakpoint
ALTER TABLE `__new_user_profile` RENAME TO `user_profile`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_username_unique` ON `user_profile` (`username`);--> statement-breakpoint
CREATE INDEX `user_profile_username` ON `user_profile` (`username`);
