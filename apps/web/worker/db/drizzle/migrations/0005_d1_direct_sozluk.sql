-- 0005 — sozluk on D1 (d1-direct/task_5).
-- `definition_view` becomes the canonical store for definitions: add a full-text
-- `body` column (the per-term DO previously held the canonical body; the view
-- only carried an excerpt). New `definition_vote` table replaces the per-term
-- DO `definition_vote` storage for the up-only MVP vote primitive.
ALTER TABLE `definition_view` ADD `body` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `definition_vote` (
	`definition_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`definition_id`, `voter_id`)
);--> statement-breakpoint
CREATE INDEX `definition_vote_definition` ON `definition_vote` (`definition_id`);
