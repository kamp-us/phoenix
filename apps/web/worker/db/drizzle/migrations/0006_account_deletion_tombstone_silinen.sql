-- ADR 0097 — account deletion = anonymize-to-`@[silinen]`.
--
-- 1. Add the `deleted_at` tombstone column to `user`: `account.delete` scrubs the
--    deleting user's row (email/name/image nulled) but KEEPS it, stamping
--    `deleted_at`, so the `author_id → silinen` redirect and the FKs stay coherent
--    and the email can re-register fresh later.
-- 2. Seed the `@[silinen]` sentinel — a real `user` row (reserved username
--    `silinen`, reserved `type='system'`) + its `user_profile` — that deleted
--    accounts' content re-attributes to. Seeded here, never creatable at runtime;
--    `Pasaport.setUsername` rejects `silinen` as reserved.
--
-- The seed is idempotent (`INSERT OR IGNORE`) so re-applying against a DB that
-- already carries the row is a no-op. Timestamps are epoch SECONDS (the
-- `integer({mode:"timestamp"})` granularity) pinned to a fixed instant so the
-- seed is deterministic across stages.

ALTER TABLE `user` ADD `deleted_at` integer;--> statement-breakpoint
INSERT OR IGNORE INTO `user` (`id`, `name`, `email`, `image`, `type`, `email_verified`, `username`, `created_at`, `updated_at`, `deleted_at`)
VALUES ('silinen', NULL, 'silinen@system.kamp.us', NULL, 'system', 0, 'silinen', 1782000000, 1782000000, NULL);--> statement-breakpoint
INSERT OR IGNORE INTO `user_profile` (`user_id`, `username`, `display_name`, `image`, `total_karma`, `definition_count`, `post_count`, `comment_count`, `updated_at`, `last_event_id`)
VALUES ('silinen', 'silinen', '@[silinen]', NULL, 0, 0, 0, 0, 1782000000, '');
