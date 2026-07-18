# Runbook: D1 export / restore

Recover the single production D1 from a bad migration or accidental data loss: export a
known-good snapshot and restore it into a fresh stage. Grounded in phoenix's real stack — the
alchemy-managed D1 (one per app/stage, ADR
[0057](../.decisions/0057-multi-app-multi-worker-repo.md)), the hand-authored flat migrations
tree applied on deploy (ADR
[0108](../.decisions/0108-hand-authored-flat-d1-migrations.md)), and the deploy-infra-to-cloud
dev model (ADR [0032](../.decisions/0032-alchemy-beta45-and-dev-model.md)) — not generic
SQLite advice.

The one non-obvious hazard this runbook handles is the **FTS5 export tax**: the site-search
FTS5 virtual tables block a naive whole-database D1 export, so the procedure exports the base
tables only and rebuilds the search index on restore (ADR
[0080](../.decisions/0080-site-search-lexical-bar-semantic-discovery.md)).

## Symptoms

Reach for this runbook when the production D1 is corrupt or wrong and rolling *forward* won't
fix it — you need a point-in-time restore, not another migration:

- A migration applied bad data or dropped/altered a column, and the loss is already live (a
  forward migration can't recover deleted rows).
- Product reads return wrong or missing rows that trace to the store, not the read path:
  sözlük terms / pano posts absent or truncated across clients, not just one stale live view
  (one stale live view is the [live-plane-degraded](./runbook-live-plane-degraded.md)
  runbook).
- You need a verified backup of production D1 before a risky migration or bulk operation — the
  export half of this runbook, run proactively.

## Preconditions

- **Cloudflare credentials with D1 access.** Export/restore uses the Cloudflare CLI against
  the real remote D1; `alchemy dev`/`deploy` and the CLI both need account auth (ADR 0032 —
  dev and prod resources are both real CF D1, there is no offline D1 emulator). The CLI is not
  a repo dependency; invoke it with `pnpm dlx wrangler` (never `npx`).
- **The physical D1 name for the stage you are acting on.** alchemy generates the production
  database name; read it from the deployed stack (the `phoenix_db` resource in
  [`apps/web/worker/db/resources.ts`](../apps/web/worker/db/resources.ts), applied by
  `alchemy deploy`). Never guess the name.
- **A scratch stage to restore into — never restore over production first.** `alchemy deploy
  --stage <scratch>` yields an isolated worker + D1 + DOs (ADR 0057), with all migrations
  applied, so the schema — including the FTS5 virtual tables from migration
  [`0002_search_fts.sql`](../apps/web/worker/db/drizzle/migrations/0002_search_fts.sql) —
  already exists. Restore into the scratch stage, verify, then decide on the production
  cutover.
- **Capture the current state first.** Record the failing migration id and the current
  `drizzle_migrations` applied set before you touch anything, so you know exactly which
  snapshot you are restoring to.

## The FTS5 export tax — why a naive export fails

Site search (ADR 0080) is two FTS5 **virtual** tables, `term_search` and `post_search`,
declared by hand in migration
[`0002_search_fts.sql`](../apps/web/worker/db/drizzle/migrations/0002_search_fts.sql)
(drizzle's DSL cannot express a virtual table). SQLite backs each FTS5 virtual table with a
set of **shadow tables** under the hood: `<name>_data`, `<name>_idx`, `<name>_content`,
`<name>_docsize`, `<name>_config`. **D1 cannot export a database that contains virtual
tables** (ADR 0080 §Sync/Trade-offs, and the export caveat recorded inline in the migration):
a whole-DB export chokes on the virtual-table + shadow-table schema.

The rows in the FTS tables are **derived, not primary**: an app-side dual-write of the
Turkish-normalized title, kept in lockstep with `term_record` / `post_record` by
[`features/search/fts-sync.ts`](../apps/web/worker/features/search/fts-sync.ts) (the `norm`
column is computed by `normalize.ts`, not stored in the base row). So the FTS index rebuilds
from the base tables and never needs to be in the backup — which is what makes the workaround
safe: export the base tables, skip the virtual tables, rebuild the index on restore.

## Procedure

All commands run from the repo root. Substitute `<prod-d1-name>` / `<scratch>` from the
preconditions; never hardcode a physical name into a committed artifact.

**1 — Export the base tables only (sidestep the virtual tables).** `wrangler d1 export`'s
`--table` flag restricts the dump to an explicit table set, so enumerating the base tables
excludes the FTS5 virtual + shadow tables and the export succeeds. Take a data-only dump
(`--no-schema`) — the scratch stage already carries the schema from applied migrations, so the
restore only needs `INSERT`s:

```bash
pnpm dlx wrangler d1 export <prod-d1-name> --remote --no-schema \
  --table term_record --table post_record --table definition_record --table comment_record \
  --table user --table <…every base table…> \
  --output ops-export.sql
```

Enumerate the real base-table set from the applied schema
([`apps/web/worker/db/drizzle/schema.ts`](../apps/web/worker/db/drizzle/schema.ts)); the two
tables you must **omit** are `term_search` and `post_search` (and, implicitly, their shadow
tables). To take a full whole-DB export instead, the alternative is to `DROP` the two virtual
tables first and recreate them after — but that is a destructive change against the live
database, so the non-destructive `--table` enumeration above is the default; use the
drop/recreate path only for a one-time full migration-out.

**2 — Restore the base data into the scratch stage.** Deploy the scratch stage (which applies
all migrations, creating every base table plus the empty FTS5 virtual tables), then execute
the dump:

```bash
alchemy deploy --stage <scratch>
pnpm dlx wrangler d1 execute <scratch-d1-name> --remote --file ops-export.sql
```

**3 — Rebuild the FTS5 index from the restored base tables.** The virtual tables exist (from
migration 0002) but are empty, because the export intentionally excluded the FTS rows. Rebuild
them by re-deriving each `norm` from the restored base rows the same way the write path does —
through the app's Turkish fold in
[`features/search/normalize.ts`](../apps/web/worker/features/search/normalize.ts) and the
dual-write shape in
[`features/search/fts-sync.ts`](../apps/web/worker/features/search/fts-sync.ts)
(`term_search(slug, norm)` from `term_record`, `post_search(id, norm)` from `post_record`).
The `norm` value is app-computed, not a pure-SQL `lower()`, so the rebuild must run the app
normalizer, not a raw SQL projection.

> **Known gap (follow-up).** There is no standing backfill route to rebuild the FTS index
> today — the write path only syncs on individual mutations, and the security guard forbids
> resurrecting an admin/seeder route (see CLAUDE.md §"Sözlük seed"). Until a sanctioned one-off
> backfill exists, the rebuild is a manual maintenance execution deriving `norm` via
> `normalize.ts`. This gap is tracked as a follow-up issue.

## Verification

Confirm the restore before you stand down or promote it toward production:

- **Row counts match the source.** For each base table, the restored count equals the exported
  count:

  ```bash
  pnpm dlx wrangler d1 execute <scratch-d1-name> --remote \
    --command "SELECT 'term_record' t, count(*) n FROM term_record
               UNION ALL SELECT 'post_record', count(*) FROM post_record;"
  ```

- **FTS search works post-restore.** A lexical + prefix match returns rows against the rebuilt
  index (a green count here proves the rebuild, not just the base restore):

  ```bash
  pnpm dlx wrangler d1 execute <scratch-d1-name> --remote \
    --command "SELECT count(*) FROM term_search WHERE term_search MATCH 'merhaba';
               SELECT count(*) FROM term_search WHERE term_search MATCH 'mer*';"
  ```

- **`integrity_check` is clean** on the restored database (`PRAGMA integrity_check;` returns
  `ok`).

Only once all three hold is the scratch restore trustworthy enough to consider a production
cutover.

## Rollback / escalation

- **The scratch restore is the rollback surface.** Because you restore into an isolated
  scratch stage (ADR 0057), a bad restore never touches production: tear the scratch stage
  down (`alchemy` destroy for that stage) and re-run from a different export. Cut over
  production only *after* the scratch verification passes.
- **If the export itself fails on virtual tables**, you skipped the `--table` enumeration or
  named a virtual table — re-run step 1 with the base-table set only (this is the FTS5 export
  tax, not a D1 outage).
- **If the FTS rebuild can't be run** (no backfill path yet — see the known gap), the base
  data is still fully restored and correct; search is degraded until the index is rebuilt.
  Escalate the backfill as a product/infra task rather than block the data restore on it.
- **If D1 itself is unavailable** (not a data problem — the store is down), this is a
  Cloudflare incident: switch to the [Cloudflare-down runbook](./runbook-cf-down.md).

## Rehearsal

The load-bearing, non-obvious mechanic — the **FTS5 export-tax workaround** (exclude the
virtual tables → export base only → reimport → recreate the FTS5 tables from the migration DDL
→ rebuild the index → verify counts + working search) — was rehearsed once locally against
SQLite 3.43.2 (FTS5-enabled), using the **verbatim DDL** from migration `0002_search_fts.sql`.
This proves the rebuild sequence and that search works after restore.

Fixture: base tables `term_record` / `post_record` plus the two FTS5 virtual tables from the
real migration DDL, seeded so search matches before restore.

```
# source: base counts + FTS search works, plus the shadow tables the export tax comes from
term_record|2
post_record|2
term MATCH merhaba|1
post MATCH kahve|1
shadow tables: term_search{,_config,_content,_data,_docsize,_idx}, post_search{…}  (12 total)

# workaround: base-only dump (no *_search shadow tables), reimport, recreate FTS from 0002 DDL,
# rebuild rows, then verify on the restored database
base-only dump — matches for 'search': 0
restored term_record|2
restored post_record|2
restored term MATCH merhaba|1     # lexical match works post-restore
restored post MATCH kahve|1
restored term MATCH mer*|1        # prefix index (prefix='2 3 4') works post-restore
restored PRAGMA integrity_check|ok
```

Result: after excluding the FTS virtual tables from the export, reimporting the base tables,
and recreating + rebuilding the FTS5 index from the migration DDL, both exact and prefix
search return the expected rows and the database passes `integrity_check`.

**Scope of this rehearsal — read before trusting it.** It validates the FTS5 export-tax
*mechanics* against a local FTS5 SQLite, where the real risk lives. It does **not** exercise
the full production round-trip: `wrangler d1 export --remote` against the production D1 and
`alchemy deploy --stage <scratch>` require Cloudflare credentials (ADR 0032) and were not run
here. One note on fidelity: the "naive whole-DB export is blocked by virtual tables" claim is
a **D1-platform** behavior recorded by ADR 0080 and the migration's inline caveat. The local
`sqlite3` shell can round-trip virtual tables via its `writable_schema` path, so this specific
tax was *not* reproduced locally and is cited from the D1 record, not re-derived. Before this
runbook is relied on for a real production restore, an operator with Cloudflare access should
rehearse the full remote round-trip once against a scratch stage and append the observed
remote evidence here.
