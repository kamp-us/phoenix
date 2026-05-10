CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_parent_id_idx` ON `comment` (`parent_id`);--> statement-breakpoint
CREATE TABLE `comment_vote` (
	`comment_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`comment_id`, `voter_id`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_meta` (
	`id` text PRIMARY KEY DEFAULT '1' NOT NULL,
	`slug` text,
	`title` text NOT NULL,
	`url` text,
	`host` text,
	`body` text,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `post_vote` (
	`voter_id` text PRIMARY KEY NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL
);
