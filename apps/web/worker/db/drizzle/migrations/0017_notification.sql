-- #1694 (epic #1666) — the bildirim spine's notification table. One row per
-- recipient-facing notification: a plain-text `kind` (sibling emitters mint kinds
-- without a migration), a polymorphic target reference (post/comment/definition/user
-- — liveness resolved at read time, tombstone when gone, never an FK), an optional
-- actor kept verbatim (no FK — the `authorship_vouch` choice), an aggregate `count`
-- slot ("3 yeni oy", #1698), and read state as a nullable `read_at` stamp so
-- "read but we don't know when" is unrepresentable.

CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`actor_id` text,
	`count` integer DEFAULT 1 NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_recipient_read` ON `notification` (`recipient_id`,`read_at`);
--> statement-breakpoint
CREATE INDEX `notification_recipient_created` ON `notification` (`recipient_id`,"created_at" DESC);
