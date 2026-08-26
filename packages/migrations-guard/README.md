# @kampus/migrations-guard

The **fail-closed CI gate over the committed D1 migrations tree** (issue
[#1435](https://github.com/kamp-us/phoenix/issues/1435), re-grounded on the v7 layout by ADR
[0309](../../.decisions/0309-v7-migrations-baseline-cutover.md)).

## What it is

A `packages/` Effect CLI per the repo's Node-over-Python convention (the
`leak-guard` / `readme-guard` / `orphan-sweep` idiom) — a pure, unit-tested core plus a thin
`effect/unstable/cli` bin — wired as a fail-closed CI job. Per ADR
[0100](../../.decisions/0100-control-plane-covers-enforcement-guard-packages.md) the guard package is
**control-plane** (human-merged).

It guards the two-layout tree the v7 cutover (ADR 0309) left behind:

- **Frozen flat history** — 34 top-level `NNNN_name.sql` files. Production recorded each
  one by its path relative to `migrationsDir`, so their names are load-bearing strings.
- **Migration directories** — `<timestamp>_<name>/migration.sql` + `snapshot.json`, what
  `drizzle-kit generate` writes from the cutover on. alchemy finds them because
  `listSqlFiles` reads the directory recursively.

The surfaces a consumer touches, file by file (`src/`):

- **`index.ts`** — the public entry: re-exports the core and the fs boundary below.
- **`migrations-guard.ts`** — the pure, IO-free core: `evaluate` (the three checks),
  `migrationNumber`, `alchemyPrefix` (a byte-for-byte mirror of alchemy's own sort key),
  `deriveBaseline`, `renderVerdict`. Total over a loaded tree; never touches disk.
- **`fs.ts`** — the filesystem boundary: `loadMigrationTree` (walks both layouts,
  builds each migration's apply id, hashes its SQL), `loadBaseline`, `serializeBaseline`.
- **`bin.ts`** — the `effect/unstable/cli` bin: the `check` and `baseline` commands under
  [How to use it](#how-to-use-it).

## Why it exists

drizzle-kit validates only what it can diff, and alchemy validates nothing at all — it applies
whatever `.sql` it finds under `migrationsDir`, skipping an applied migration by exact id match
against `drizzle_migrations.name` (`migrationsTable: "drizzle_migrations"`,
[`apps/web/worker/db/resources.ts`](../../apps/web/worker/db/resources.ts)), where the id
is the path relative to `migrationsDir`. Two failure modes follow, and the guard makes both loud:

- **Editing a landed migration** won't re-run on prod (already applied) but **will apply
  as-edited on a fresh integration `it-*` DB** — integration goes green, prod stays stale,
  undetectably.
- **Renaming or moving one** changes its id, so alchemy has never seen it and re-applies
  it — against a database that already ran it. That is the replay ADR 0309 exists to avoid.

Scope boundary: the guard checks exactly the committed `apps/web` D1 tree against its committed
baseline. It validates migration-tree *shape*, ordering, and immutability — not schema semantics,
and no database other than that tree. Like every enforcement guard it fails closed on zero scope
(ADR [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)): an empty tree is a
violation, never a pass.

## How to use it

The gate — verify the committed tree is consistent, ordered, and immutable vs the baseline.
Exits **1** on any violation (the report is on stdout); this is what CI runs:

```bash
node packages/migrations-guard/src/bin.ts check
```

Both commands take the same two flags; the defaults resolve to `apps/web/…/migrations` and this
package's `migration-hashes.json`, so `check` runs the same from any CWD (a CI step, a local
invocation):

```bash
node packages/migrations-guard/src/bin.ts check \
  --migrations apps/web/worker/db/drizzle/migrations \
  --baseline packages/migrations-guard/migration-hashes.json
```

Regenerate the baseline after a deliberate, audited re-baseline (a human-reviewed control-plane
act, never something CI does):

```bash
node packages/migrations-guard/src/bin.ts baseline
```

## The three properties

The pure core ([`src/migrations-guard.ts`](src/migrations-guard.ts)) evaluates a loaded
`MigrationTree` + a committed baseline and returns every violation:

1. **Consistency** — the tree is a shape both tools accept: every `.sql` under
   `migrationsDir` is one of the two layouts above, every migration directory carries a
   `snapshot.json`, no `meta/` directory is back, no two migrations share an apply prefix,
   every migration has a numeric prefix, and no **new** flat migration was hand-added (the
   flat layout is frozen history). The `.sql` sweep matches alchemy's reach exactly:
   `listSqlFiles` recurses, so the guard recurses. `0001_x/evil.sql` — which would sort
   *into* applied history — and `<dir>/sub/y.sql` both red rather than passing unseen. A
   tree with zero migrations is a violation, not a pass: fail-closed on zero scope, ADR
   [0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md).
2. **Ordering** — the flat `NNNN` numbers run contiguous from 0, and every migration
   directory's prefix sorts **after** all of them under alchemy's own `getPrefix`
   (`Number.parseInt(name.split("_")[0], 10)`), so a new migration can never be applied
   ahead of applied history.
3. **Immutability** — every migration recorded in the baseline (`migration-hashes.json`)
   has an **unchanged** SQL content hash. An edit to landed history fails; a **new
   trailing** migration absent from the baseline passes (it is not yet history); a
   deleted/renamed baselined migration fails.

## The baseline (`migration-hashes.json`)

Immutability is checked against a **committed baseline** — `tag → sha256` of the
migration's SQL, where the tag is the flat file's stem or the migration directory's name.
`check` recomputes and compares; a missing baseline file reads as empty, which fails closed —
every flat migration absent from it reds. A new trailing migration is simply absent from the
baseline and passes; adding it via [`baseline`](#how-to-use-it) is the deliberate, audited act.
Because the tag for a flat migration is unchanged by the v7 cutover, the hashes recorded
before it carry over untouched — the diff a re-baseline produces is exactly the set of
migrations newly brought under the check.

## Testing

```bash
pnpm --filter @kampus/migrations-guard test        # vitest unit tier
pnpm --filter @kampus/migrations-guard typecheck   # tsc
pnpm --filter @kampus/migrations-guard check       # the gate itself, against the real tree
```

The unit tier runs the core against synthetic trees — each property's violations, the
new-trailing-migration pass, and the fs round-trip against a temp tree (`src/*.unit.test.ts`)
— so no real migrations directory is needed.
