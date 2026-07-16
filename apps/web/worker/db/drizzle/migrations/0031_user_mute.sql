CREATE TABLE `user_mute` (
	`muter_id` text NOT NULL,
	`muted_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`muter_id`, `muted_id`)
);
--> statement-breakpoint
CREATE INDEX `user_mute_muted` ON `user_mute` (`muted_id`);