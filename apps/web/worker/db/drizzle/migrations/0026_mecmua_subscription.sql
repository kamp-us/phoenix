CREATE TABLE `mecmua_subscription` (
	`author_id` text NOT NULL,
	`subscriber_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`subscriber_id`, `author_id`)
);
--> statement-breakpoint
CREATE INDEX `mecmua_subscription_subscriber` ON `mecmua_subscription` (`subscriber_id`,"created_at" DESC);