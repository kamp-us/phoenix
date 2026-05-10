DROP TABLE `post_vote`;--> statement-breakpoint
CREATE TABLE `post_vote` (
	`post_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`post_id`, `voter_id`)
);
