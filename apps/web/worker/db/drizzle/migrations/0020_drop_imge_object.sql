-- #1982 — drop the dead `imge_object` table. imge (ADR 0044) was superseded and its
-- object-metadata store never got a consumer: no worker code reads or writes it, and
-- the R2-backed successor does not reuse this D1 table. So it is dead-but-applied schema
-- on prod D1 — a loose end from the imge supersede. Because flat D1 migrations are
-- immutable (ADR 0108), the create (`0014_imge_object`) cannot be edited away in place;
-- retiring the table requires this forward drop-migration.
--
-- DESTRUCTIVE by construction: `DROP TABLE` discards the table and its rows. The table
-- holds no live data (zero consumers ever wrote it), so nothing is lost. SQLite/D1 drop
-- a table's own indexes with it, so the `imge_object_owner_created` index needs no
-- separate DROP.

DROP TABLE `imge_object`;
