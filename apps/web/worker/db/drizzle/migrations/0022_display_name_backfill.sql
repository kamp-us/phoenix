-- #2154 — backfill the stamped `user_profile.display_name` from the authoritative
-- better-auth `user.name`, reconciling the rows that predate the forward-sync
-- write-through.
--
-- Root cause (verified vs origin/main): `user_profile.display_name` was written in
-- exactly one place — `upsertProfileIdentity`, called ONLY from `setUsername`, which
-- copies `user.name` at username-set time and never again. So a display-name change
-- after username-set never reached the stamped column, and any row stamped before a
-- rename carries a stale name. The forward-sync half (`user.setDisplayName`) fixes
-- this going forward; this migration reconciles the existing drift.
--
-- Only rows where the stamped column disagrees with the live `user.name` are
-- touched, and ONLY when `user.name` is non-null — so the `@[silinen]` sentinel
-- (seeded in 0006 with `user.name = NULL` but `display_name = '@[silinen]'`) is
-- never blanked: its `user.name IS NULL`, so the guard excludes it. A row already in
-- sync (or an anonymized tombstone with a null name) is left untouched, so the
-- backfill is idempotent — re-applying reconciles nothing.
UPDATE `user_profile`
SET `display_name` = (SELECT `name` FROM `user` WHERE `user`.`id` = `user_profile`.`user_id`)
WHERE EXISTS (
	SELECT 1 FROM `user`
	WHERE `user`.`id` = `user_profile`.`user_id`
		AND `user`.`name` IS NOT NULL
		AND (`user_profile`.`display_name` IS NULL OR `user_profile`.`display_name` <> `user`.`name`)
);
