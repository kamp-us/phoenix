---
id: 0309
title: Cut Over to drizzle-kit v7 by Baselining, Not by Renaming History
status: accepted
date: 2026-08-19
tags: [database, tooling, migrations]
---

# 0309 — Cut Over to drizzle-kit v7 by Baselining, Not by Renaming History

## Context

`drizzle-kit generate` could not run in `apps/web`. The catalog-pinned
`drizzle-kit@1.0.0-rc.4` trips its `assertV3OutFolder` gate on the mere presence of
`apps/web/worker/db/drizzle/migrations/meta/_journal.json` — the legacy flat layout —
and exits with `Your migrations folder format is outdated, please run drizzle-kit up`
without writing anything. [ADR 0108](0108-hand-authored-flat-d1-migrations.md)
sanctioned hand-authoring the `.sql`, the journal entry and the snapshot by hand (§1/§2)
and deferred the cutover to one coordinated PR (§3). Both of its sequencing
preconditions (#1109, #1228) are closed. This is that cutover (#6438).

**`drizzle-kit up`, the path ADR 0108 §3 assumed, cannot be taken.** It deletes `meta/`
and moves every migration to `<timestamp>_<name>/migration.sql`, which changes every
migration's **apply id**. alchemy skips an already-applied migration by exact id match,
and the id is the path relative to `migrationsDir`:

- `alchemy/lib/Sql/SqlFile.js` — `listSqlFiles` reads the directory recursively;
  `readSqlFile` sets `const file = { id: name, sql, hash }`, where `name` is that
  relative path.
- `alchemy/lib/cloudflare/D1/ApplyMigrations.js` — `if (applied.has(migration.id))
  continue;`, where `applied` comes from `getAppliedMigrations`'s
  `SELECT name FROM ${migrationsTable};` and the recorded `name` is that same relative
  path.

Production's `drizzle_migrations.name` holds `0000_d1_baseline.sql` …
`0033_caylak_visibility_preference.sql`. After `up`, not one of those strings matches, so the next
deploy re-applies all 34 against prod and every stage — and `0000_d1_baseline.sql`
alone carries 16 bare `CREATE TABLE` with no `IF NOT EXISTS`, with 15 later migrations
carrying `DROP TABLE` / `DROP COLUMN`. `up` also leaves the tree in a state where a
`generate` with `schema.ts` untouched emits a destructive `__new_*` table-swap diff,
so it does not even buy a clean floor.

## Decision

**Baseline instead of rename.** Three moves, landed together:

1. **Delete `migrations/meta/` in full** — all 35 files including `_journal.json`.
   The snapshots are advisory (ADR 0108 §1) and alchemy reads only `.sql`, so this is
   invisible at apply time; removing `_journal.json` is exactly what clears
   `assertV3OutFolder`.
2. **Leave all 34 flat `NNNN_*.sql` byte-identical and in place.** Their apply ids are
   unchanged strings, so the applied record stays valid and nothing replays.
3. **Seed one v7 baseline directory** — `20260820113338_v7_baseline/` — holding the
   tool-generated `snapshot.json` of the current `schema.ts`, with its `migration.sql`
   neutered to a comment-only no-op before committing. alchemy sees one new id and will
   run that file, so its generated body (a 371-line create-everything script) must never
   ship. The directory's numeric prefix is a timestamp, and alchemy's `getPrefix`
   (`Number.parseInt(name.split("_")[0], 10)`) parses it as a number far above 32, so it
   always sorts after the flat history.

From here on, **`drizzle-kit generate` run incrementally against the committed tree is
the authoring path**, and it writes `<timestamp>_<name>/migration.sql` + `snapshot.json`
directories that alchemy picks up (its listing recurses). ADR 0108's §1/§2
hand-authoring path is retired; its §3 deferral is discharged by this decision, by a
different mechanism than the one it named.

`packages/migrations-guard` is re-grounded on the new tree rather than deleted: it read
`meta/_journal.json` directly, so it would have thrown the moment `meta/` went. It now
loads both layouts, keys the immutability baseline on the same tags (so the 34 recorded
hashes carry over unchanged), and reds on a new flat migration, a directory missing its
`snapshot.json`, a duplicate apply prefix, and a directory whose prefix would sort into
applied history. Its walk matches alchemy's reach rather than approximating it: it
collects every `.sql` under `migrationsDir` at any depth, exactly as `listSqlFiles` does,
and reds on each one that is neither a top-level flat migration nor a
`<prefix>_<name>/migration.sql` — so a file alchemy would apply can never be one no check
covers. It still fails closed on zero scope (ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)).

## Consequences

- **Nothing replays.** The 34 applied ids are untouched strings; the only id alchemy has
  not seen is `20260820113338_v7_baseline/migration.sql`, whose body is comments. The
  guard's immutability check is what keeps that true on every later PR.
- **`generate` works again**, and with it the drift check that came free with it: a
  schema change that is not migrated now shows up as a non-empty `generate`.
- **This baselines whatever drift already exists** between the flat history and
  `schema.ts` rather than reconciling it. The v7 snapshot is a photograph of `schema.ts`,
  not of production; if the two disagree, the disagreement is now silent instead of
  latent. That is accepted, not overlooked — the `up` path surfaces such drift but
  cannot cleanly resolve it either (it emits a destructive table-swap diff with
  `schema.ts` untouched), and reconciling schema against live D1 is its own piece of
  work.
- **The advisory-snapshot era ends.** A hand-written snapshot no longer exists to be
  subtly wrong; the snapshot chain is tool-written from here.
- **The baseline file grew by 12 rows.** The committed
  `packages/migrations-guard/migration-hashes.json` covered `0000`–`0022` only —
  migrations `0023`–`0033` had landed unbaselined, because the old guard let any new
  trailing migration pass. Re-baselining brings all 34 flat migrations plus the new
  directory under the immutability check.
- `.patterns/alchemy-drizzle-d1.md` and `DEVELOPMENT.md` are updated to the `generate`
  path; ADR 0108 is marked superseded and points here.
