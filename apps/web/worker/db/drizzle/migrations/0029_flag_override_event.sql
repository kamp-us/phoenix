-- #2741 (admin-console epic #2711) — the append-only runtime feature-flag override log. The
-- SINGLE source of both the audit trail and the current per-flag runtime override: the effective
-- override is a projection of the latest row (see `features/flagship/flag-override.ts`), so an
-- admin's in-app flag flip can never drift from history and every prod flip is auditable by
-- construction. Keyed by `flag_key` (the shared `src/flags/keys.ts` constant); `action` is
-- tri-state (`on`/`off` force the effective value, `clear` lifts the override); `actor_id` is the
-- discharged `Admin` grant's account id (the audit stamp, no FK — mirrors `user_ban_event.actor_id`).
-- The runtime-override `Flags` wrapper reads the latest row per key; the `flag.setOverride` mutation
-- appends. Mirrors `user_ban_event` / `email_delivery_event`.

CREATE TABLE `flag_override_event` (
	`id` text PRIMARY KEY NOT NULL,
	`flag_key` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flag_override_event_key_created` ON `flag_override_event` (`flag_key`,"created_at" DESC);
