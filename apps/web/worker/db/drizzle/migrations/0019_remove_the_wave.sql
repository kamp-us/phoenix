-- #1855 — remove-the-wave grouping identity (ADR 0138). A wave-remove stamps ONE
-- shared `wave_id` across every target resolved in a single gesture, so the batch
-- reopens as a unit (`Report.reopenForWave`, the primitive #1704's restore mutation
-- calls). NULL on a single-target resolve — a wave groups a batch, a lone resolve
-- has none. Nullable text + a lookup index for the reopen-by-wave read.

ALTER TABLE `content_report` ADD `wave_id` text;--> statement-breakpoint
CREATE INDEX `content_report_wave` ON `content_report` (`wave_id`);
