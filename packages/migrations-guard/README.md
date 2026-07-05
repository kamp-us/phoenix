# @kampus/migrations-guard

The **fail-closed CI gate over the hand-authored flat D1 migrations tree** (issue
[#1435](https://github.com/kamp-us/phoenix/issues/1435)). ADR
[0108](../../.decisions/0108-hand-authored-flat-d1-migrations.md) sanctions
hand-authored flat migrations (`apps/web/worker/db/drizzle/migrations/NNNN_name.sql`
plus a central `meta/_journal.json` and per-migration `meta/NNNN_*_snapshot.json`
snapshots) and, in doing so, **disabled the only tool that validated the tree**:
`drizzle-kit generate`/`up` aborts against the committed flat layout (its
`assertV3OutFolder` gate). Nothing replaced it — a grep of `.github/workflows/**` for
`migration`/`journal`/`drizzle` returned nothing. This package is that replacement.

It is a `packages/` Effect CLI per the repo's Node-over-Python convention (the
`leak-guard` / `readme-guard` / `flake-rate` idiom) — a pure, unit-tested core plus a
thin `effect/unstable/cli` bin — wired as a fail-closed CI job. Per ADR
[0100](../../.decisions/0100-control-plane-covers-enforcement-guard-packages.md) the guard package is
**control-plane** (human-merged).

## Why it exists — the drift it catches

The applied set is tracked by **content hash** in D1's `drizzle_migrations` table
(`migrationsTable: "drizzle_migrations"`,
[`apps/web/worker/db/resources.ts`](../../apps/web/worker/db/resources.ts)). So editing
an already-journaled migration **won't re-run on prod** (already applied) but **will
apply as-edited on a fresh integration `it-*` DB** — integration goes green, prod stays
stale, undetectably. That is the sharpest failure mode; the guard makes it loud.

## The three properties

The pure core ([`src/migrations-guard.ts`](src/migrations-guard.ts)) evaluates a loaded
`MigrationTree` + a committed baseline and returns every violation:

1. **Consistency** — the `.sql` files, the journal `entries`, and the `*_snapshot.json`
   files name the **same** migration set (count agreement; no `.sql` without a journal
   entry or snapshot, and vice versa; no duplicate-numbered migration). Matched by
   leading `NNNN` number, so the committed bare-vs-tagged snapshot naming
   (`0000_snapshot.json` vs `0003_post_bookmark_snapshot.json`) is not a false mismatch.
2. **Ordering** — journal `idx` runs `0,1,2,…` contiguous and unique, each entry's `idx`
   matches its `tag`'s number, and the `.sql` numbers likewise run contiguous from 0.
3. **Immutability** — every migration recorded in the baseline (`migration-hashes.json`)
   has an **unchanged** SQL content hash. An edit to journaled history fails; a **new
   trailing** migration absent from the baseline passes (it is not yet history); a
   deleted/renamed baselined migration fails.

## The baseline (`migration-hashes.json`)

Immutability is checked against a **committed baseline** — `tag → sha256(.sql)` for the
current committed history. `check` recomputes and compares. A new trailing migration is
simply absent from the baseline and passes; adding it to the baseline is a **deliberate,
audited** act:

```bash
node packages/migrations-guard/src/bin.ts baseline   # regenerate after a deliberate re-baseline
```

This is the escape hatch the #1435 triage notes call for: the #1306 flat→per-dir
`drizzle-kit up` cutover rewrites every journaled migration by construction, so whichever
lands second re-baselines here on purpose (a reviewed diff to `migration-hashes.json`),
rather than the guard flagging the cutover as a mass immutability violation.

## Shape

- **`src/migrations-guard.ts`** — the pure, IO-free core: `evaluate` (the three checks),
  `migrationNumber`, `deriveBaseline`, `renderVerdict`. Total over a loaded tree; never
  touches disk.
- **`src/fs.ts`** — the filesystem boundary: `loadMigrationTree` (reads the `.sql` files,
  hashes their bytes, parses the journal, lists the snapshots), `loadBaseline`,
  `serializeBaseline`.
- **`src/bin.ts`** — the `effect/unstable/cli` bin. `check` is the gate (exits **1** on
  any violation); `baseline` regenerates the committed baseline.
- **`src/*.unit.test.ts`** — the core's unit tests: each property's violations, the
  new-trailing-migration pass, and the fs round-trip against a temp tree.

## Usage

```bash
# The gate: verify the committed tree is consistent, ordered, and immutable. Exits 1 on
# any violation (the report is on stdout). This is what CI runs.
node packages/migrations-guard/src/bin.ts check

# Point at a different tree / baseline (defaults resolve to apps/web/…/migrations and
# this package's migration-hashes.json).
node packages/migrations-guard/src/bin.ts check --migrations <dir> --baseline <file>
```
