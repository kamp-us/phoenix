CREATE TABLE `definition` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `definition_vote` (
	`definition_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`definition_id`, `voter_id`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `term_meta` (
	`id` text PRIMARY KEY DEFAULT '1' NOT NULL,
	`title` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
