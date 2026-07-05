-- #2131 — run-once completion marker for the one-time full `hot_score` backfill.
-- #2033's decay cron is window-scoped to 72h, so a post that froze high before that
-- fix and now sits outside the window never re-decays — it stays pinned #1 on the
-- sıcak feed. The one-time fix is a WINDOWLESS recompute over all rows. The formula
-- uses `POW` (`^1.8`, `db/hotScore.ts`), which SQLite/D1 lacks, so the backfill can't
-- be pure SQL here — it reuses the worker-side pure core (`decayHotScores`). This table
-- is the persisted "already ran" signal: the guarded run-once path inserts the `id = 1`
-- row on completion and no-ops thereafter (idempotent). Singleton, `pano_stats` idiom.
CREATE TABLE `hot_score_backfill` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`completed_at` integer NOT NULL,
	`scanned` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL
);
