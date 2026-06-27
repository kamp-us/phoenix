-- #1205 — the çaylak mod-only sandbox, on the ADR 0096 lifecycle substrate.
-- `sandboxed_at` is one nullable timestamp per content table, mirroring the
-- `removed_at` soft-state shape: null ⇒ not sandboxed (live or removed); a
-- timestamp ⇒ the row is sandboxed (visible to its author + moderators only)
-- until the çaylak→yazar promotion (#1206) clears it. The closed `EntityLifecycle`
-- union (`Live | Sandboxed | Removed`) makes sandboxed-AND-removed unrepresentable;
-- `toColumns` never writes `sandboxed_at` and `removed_at` both non-null. Existing
-- rows backfill to NULL (= not sandboxed) via the nullable ADD with no default —
-- zero behavior change until the authorship-loop flag is flipped on.

ALTER TABLE `definition_record` ADD `sandboxed_at` integer;--> statement-breakpoint
ALTER TABLE `post_record` ADD `sandboxed_at` integer;--> statement-breakpoint
ALTER TABLE `comment_record` ADD `sandboxed_at` integer;--> statement-breakpoint
CREATE INDEX `definition_record_sandboxed` ON `definition_record` (`sandboxed_at`);--> statement-breakpoint
CREATE INDEX `post_record_sandboxed` ON `post_record` (`sandboxed_at`);--> statement-breakpoint
CREATE INDEX `comment_record_sandboxed` ON `comment_record` (`sandboxed_at`);
