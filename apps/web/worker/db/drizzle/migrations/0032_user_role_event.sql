-- #3522 (admin epic, ADR 0107) — the append-only platform-role assignment log. The
-- audit trail for the `Admin.over(platform)`-gated `user.setRole` mutation, which
-- writes the `moderates` relation tuple the console needs (#969/PR #1266 shipped only
-- the offline mint). State is a projection of the latest row (`role`), mirroring
-- `user_ban_event`, so the log can never drift from the `relation_tuple` write the
-- mutation commits alongside it. The `(user_id, created_at DESC)` index serves the
-- per-account latest-event read.

CREATE TABLE `user_role_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_role_event_user_created` ON `user_role_event` (`user_id`,"created_at" DESC);
