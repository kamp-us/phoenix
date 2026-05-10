CREATE TABLE `comment_vote` (
	`user_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`user_id`, `comment_id`),
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_vote_comment_id_idx` ON `comment_vote` (`comment_id`);--> statement-breakpoint
CREATE TABLE `post_vote` (
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`user_id`, `post_id`),
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_vote_post_id_idx` ON `post_vote` (`post_id`);