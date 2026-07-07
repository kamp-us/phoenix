-- #2133 — drop the `hot_score_backfill` run-once marker table. The one-time full
-- `hot_score` backfill (#2131) existed SOLELY to reach posts stranded outside the old
-- 72h decay window; making the go-forward decay WINDOWLESS (#2133) re-decays every live
-- non-draft post each pass, so the backfill (and its marker) have no reason to exist.
-- The worker no longer reads or writes this table. Flat D1 migrations are immutable
-- (ADR 0108), so retiring the table requires this forward drop-migration.
--
-- DESTRUCTIVE by construction: `DROP TABLE` discards the table and its rows. The only
-- row it ever held was the singleton run-once marker — no domain data — so nothing is
-- lost. SQLite/D1 drop a table's own indexes with it; this table had none.

DROP TABLE `hot_score_backfill`;
