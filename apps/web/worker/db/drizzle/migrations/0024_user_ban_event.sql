-- #970 (epic #968) — the append-only ban/unban event log. The SINGLE source of both
-- the audit trail and the current ban-state: state is a projection of the latest row
-- (see `features/pasaport/ban.ts`), so it can never drift from history. Enforcement
-- (`Pasaport.validateSession`) reads the latest row per request off the
-- `(user_id, created_at DESC)` index to refuse a banned user's existing session.

CREATE TABLE `user_ban_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_ban_event_user_created` ON `user_ban_event` (`user_id`,"created_at" DESC);
