-- #853 — rename the two D1 stores of record off the projection-era `*_view`
-- name onto the `*_record` name. `definition_view`/`comment_view` are the
-- authoritative MUTATED stores (D1-direct, ADR 0009), not read projections, and
-- their old name collided one capital apart with the fate `DefinitionView`/
-- `CommentView` data views in the same feature folders. Renamed to
-- `definition_record`/`comment_record` (the vocab owner's call, supersedes the
-- issue's bare `definition`/`comment` AC — bare names would overlap the fate
-- data-view tags; `_record` reads as "store of record" and stays distinct).
--
-- DATA-PRESERVING by construction: `ALTER TABLE ... RENAME TO` keeps every row;
-- there is NO drop-and-recreate (a botch here is data loss). SQLite carries the
-- existing indexes onto the renamed table but keeps their OLD names and has no
-- `RENAME INDEX`, so each index is DROP'd and re-CREATE'd under its new name on
-- the renamed table — same columns, same (non-unique) shape as before.

ALTER TABLE `definition_view` RENAME TO `definition_record`;--> statement-breakpoint
ALTER TABLE `comment_view` RENAME TO `comment_record`;--> statement-breakpoint
DROP INDEX `definition_view_author_created`;--> statement-breakpoint
DROP INDEX `definition_view_term_score`;--> statement-breakpoint
DROP INDEX `comment_view_author_created`;--> statement-breakpoint
DROP INDEX `comment_view_post`;--> statement-breakpoint
DROP INDEX `comment_view_parent`;--> statement-breakpoint
CREATE INDEX `definition_record_author_created` ON `definition_record` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `definition_record_term_score` ON `definition_record` (`term_slug`,`score`);--> statement-breakpoint
CREATE INDEX `comment_record_author_created` ON `comment_record` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comment_record_post` ON `comment_record` (`post_id`);--> statement-breakpoint
CREATE INDEX `comment_record_parent` ON `comment_record` (`parent_id`);
