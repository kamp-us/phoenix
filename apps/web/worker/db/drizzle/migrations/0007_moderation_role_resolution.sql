-- ADR 0098 — moderation role + report resolution lifecycle.
-- `user.role`: the server-managed moderation capability (NOT the better-auth admin
-- plugin — deferred to #873), born 'member', granted only by the offline D1 script.
-- `content_report`: the resolution audit triad (resolver_id / resolved_at /
-- resolution), NULL while a report is open; written only on a terminal transition.
-- The `status` value-set widens to the closed state machine ('open' | 'resolved' |
-- 'dismissed') — SQLite stores `text` so the existing rows keep their 'open' value.
--
-- NOTE (#157/#913 parallel): numbered 0007 to leave 0006 to the account-deletion PR
-- #913, which adds 0006 and also touches the `user` table — the `user` edit here is
-- the single additive `role` column so the two reconcile cleanly on rebase.

ALTER TABLE `user` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_report` ADD `resolver_id` text;--> statement-breakpoint
ALTER TABLE `content_report` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `content_report` ADD `resolution` text;
