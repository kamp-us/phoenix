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

## Amendment (2026-08-23, #7055): landed migrations are immutable in name, and the migrate path refuses drift

The cutover's no-replay property held only for migrations the baseline knew. A migration
that landed *after* the last deliberate re-baseline passed the guard as "new trailing
history" — so a later rename or deletion of it (which changes its apply id) was invisible
to CI, and alchemy's exact-id skip then replayed its SQL against every stage that had
already applied it. PR #7034 hit this live: its stage applied two migrations as flat
files, an in-PR repair moved them to the directory layout, and the redeploy died on
`table user_activity_day already exists`. Two changes close the two halves:

1. **Every migration lands with its baseline row** (`migrations-guard` consistency). A
   directory migration absent from `migration-hashes.json` is now a violation — the fix is
   running `node packages/migrations-guard/src/bin.ts baseline` in the same change. That
   puts the whole tree under the immutability check from the moment it exists, so any
   later rename or deletion of a landed migration file reds in CI (the existing
   baselined-tag-missing violation) and a purely additive change keeps passing. Writing
   the baseline stays a reviewed act — it is now reviewed inside the PR that adds the
   migration, not deferred to an eventual re-baseline.
2. **The migrate path surfaces record-vs-disk drift and asks adopt-or-wipe** (the
   `patches/alchemy@2.0.0-beta.59.patch` D1 hunk, ADR 0038). Before applying anything,
   `applyMigrations` compares the database's recorded migration ids against the on-disk
   files; a recorded id gone from disk refuses the deploy instead of replaying. Renames
   are classified by content hash against the resource state's last-deploy
   `migrationsHashes`: `migrationsDriftStrategy: "adopt"` (phoenix: deploy with
   `D1_MIGRATIONS_DRIFT=adopt`, `worker/env.ts`) re-keys a content-identical rename in the
   migrations table without re-running its SQL, and never covers a deletion — those take
   the wipe route (`alchemy destroy --stage <stage>`) or restoring the file. This is what
   covers the within-PR window CI cannot see: a migration applied to a stage and then
   renamed before it was ever baselined.

The behavior is pinned by `patch-pin-alchemy-d1-migrations-drift.unit.test.ts`
(`.patterns/dependency-patch-behavior-pins.md`).
