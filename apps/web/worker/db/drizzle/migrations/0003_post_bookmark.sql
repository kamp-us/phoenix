CREATE TABLE `post_bookmark` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `post_bookmark_pk` PRIMARY KEY(`post_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `post_bookmark_user_created` ON `post_bookmark` (`user_id`,"created_at" DESC);
