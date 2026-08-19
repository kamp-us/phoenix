-- #6422 (epic #4306) — the yazar's "çaylak katkılarını yerinde göster" opt-in.
-- Presence is the preference: one row per opted-in account, no `false` row, so an
-- opt-out is a delete and "opted in, when unknown" cannot be stored. Its own table
-- rather than a `user_profile` column because `user_profile` is a recomputable
-- summary cache; this row is authored user intent no recompute could restore.

CREATE TABLE `caylak_visibility_preference` (
	`user_id` text PRIMARY KEY NOT NULL,
	`set_at` integer NOT NULL
);
