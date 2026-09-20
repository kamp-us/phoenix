CREATE TABLE `mecmua_post` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`slug` text,
	`author_id` text NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mecmua_post_author_created` ON `mecmua_post` (`author_id`,"created_at" DESC);