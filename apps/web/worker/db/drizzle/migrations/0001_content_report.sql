CREATE TABLE `content_report` (
	`id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `content_report_pk` PRIMARY KEY(`reporter_id`, `target_kind`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `content_report_target` ON `content_report` (`target_kind`,`target_id`);
