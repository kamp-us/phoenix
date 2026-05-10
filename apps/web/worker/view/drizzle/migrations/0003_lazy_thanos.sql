-- 0003 — replace `post_summary_author_created` with a `(author_id, created_at DESC)`
-- index so the profile feed read (`/u/<username>`) walks the index forward for the
-- newest-first ordering. The old ASC-on-both index forced a sort step on retrieval.
DROP INDEX IF EXISTS `post_summary_author_created`;--> statement-breakpoint
CREATE INDEX `post_summary_author_created` ON `post_summary` (`author_id`,`created_at` DESC);
