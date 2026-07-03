CREATE TABLE `user_reaction` (
	`user_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `target_kind`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `user_reaction_target` ON `user_reaction` (`target_kind`,`target_id`);
