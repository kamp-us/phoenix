CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `apiKey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`user_id` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`rate_limit_enabled` integer DEFAULT false NOT NULL,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0 NOT NULL,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`permissions` text,
	`metadata` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `comment_view` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`post_id` text NOT NULL,
	`post_title` text NOT NULL,
	`parent_id` text,
	`body` text DEFAULT '' NOT NULL,
	`body_excerpt` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`last_event_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comment_view_author_created` ON `comment_view` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comment_view_post` ON `comment_view` (`post_id`);--> statement-breakpoint
CREATE INDEX `comment_view_parent` ON `comment_view` (`parent_id`);--> statement-breakpoint
CREATE TABLE `comment_vote` (
	`comment_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`comment_id`, `voter_id`)
);
--> statement-breakpoint
CREATE INDEX `comment_vote_comment` ON `comment_vote` (`comment_id`);--> statement-breakpoint
CREATE TABLE `definition_view` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`term_slug` text NOT NULL,
	`term_title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`body_excerpt` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`last_event_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `definition_view_author_created` ON `definition_view` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `definition_view_term_score` ON `definition_view` (`term_slug`,`score`);--> statement-breakpoint
CREATE TABLE `definition_vote` (
	`definition_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`definition_id`, `voter_id`)
);
--> statement-breakpoint
CREATE INDEX `definition_vote_definition` ON `definition_vote` (`definition_id`);--> statement-breakpoint
CREATE TABLE `pano_stats` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`total_posts` integer DEFAULT 0 NOT NULL,
	`total_comments` integer DEFAULT 0 NOT NULL,
	`total_authors` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`title` text NOT NULL,
	`url` text,
	`host` text,
	`body` text DEFAULT '' NOT NULL,
	`body_excerpt` text,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`hot_score` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`deleted_at` integer,
	`last_event_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `post_summary_hot` ON `post_summary` (`hot_score`);--> statement-breakpoint
CREATE INDEX `post_summary_new` ON `post_summary` (`created_at`);--> statement-breakpoint
CREATE INDEX `post_summary_top` ON `post_summary` (`score`);--> statement-breakpoint
CREATE INDEX `post_summary_discuss` ON `post_summary` (`comment_count`);--> statement-breakpoint
CREATE INDEX `post_summary_host` ON `post_summary` (`host`);--> statement-breakpoint
CREATE INDEX `post_summary_author_created` ON `post_summary` (`author_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `post_vote` (
	`post_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `voter_id`)
);
--> statement-breakpoint
CREATE INDEX `post_vote_post` ON `post_vote` (`post_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `sozluk_stats` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`total_definitions` integer DEFAULT 0 NOT NULL,
	`total_terms` integer DEFAULT 0 NOT NULL,
	`total_authors` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `term_summary` (
	`slug` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`first_letter` text NOT NULL,
	`definition_count` integer DEFAULT 0 NOT NULL,
	`total_score` integer DEFAULT 0 NOT NULL,
	`excerpt` text,
	`top_definition_id` text,
	`first_at` integer,
	`last_activity_at` integer,
	`last_edit_at` integer,
	`last_event_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `term_summary_recent` ON `term_summary` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `term_summary_popular` ON `term_summary` (`total_score`);--> statement-breakpoint
CREATE INDEX `term_summary_letter` ON `term_summary` (`first_letter`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`image` text,
	`type` text DEFAULT 'human' NOT NULL,
	`email_verified` integer,
	`username` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `user_profile` (
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
CREATE UNIQUE INDEX `user_profile_username_unique` ON `user_profile` (`username`);--> statement-breakpoint
CREATE INDEX `user_profile_username` ON `user_profile` (`username`);--> statement-breakpoint
CREATE TABLE `user_vote` (
	`user_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `target_kind`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `user_vote_target` ON `user_vote` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
