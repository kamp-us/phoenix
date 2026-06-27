---
id: 0108
title: Hand-Authored Flat D1 Migrations Are the Sanctioned Path; Defer the drizzle-kit v7 Cutover
status: accepted
date: 2026-06-27
tags: [database, tooling, migrations]
---

# 0108 — Hand-Authored Flat D1 Migrations Are the Sanctioned Path; Defer the drizzle-kit v7 Cutover

## Context

The catalog pins `drizzle-kit` and `drizzle-orm` at `1.0.0-rc.3`
(`pnpm-workspace.yaml`). The committed migrations under
`apps/web/worker/db/drizzle/migrations/` use the **flat layout**: top-level
`NNNN_name.sql` files, a central `meta/_journal.json`, and per-migration
`meta/NNNN_*_snapshot.json` files. There are 15 migrations (`0000`–`0014`); every
snapshot carries `"version": "6"`, the journal's per-entry `version` is `"6"`, and
the journal's own envelope `version` is `"7"`.

`drizzle-kit generate` aborts against this committed tree **even when nothing has
changed**, printing `Your migrations folder format is outdated, please run
drizzle-kit up`. This makes the documented `generate` authoring path unusable, and
the last several migrations were instead **hand-authored** (the SQL plus a journal
entry plus a hand-assembled v6 snapshot). The next person reaching for `generate`
hits the same wall. (Originated as a report against PR #211 / issue #151; re-filed
as this decision.)

**Root cause, grounded in the pinned tool's own source** (`drizzle-kit@1.0.0-rc.3`,
`bin.cjs`):

- The first gate is `assertV3OutFolder(out)`: when `<out>/meta/_journal.json`
  **exists**, it unconditionally `console.log`s the "outdated … run drizzle-kit up"
  message and `process.exit(1)`. The blocker is the **flat-folder layout** (the mere
  presence of a central `meta/_journal.json`), *not* a snapshot-content read.
  drizzle-kit 1.0's `prepareOutFolder` reads per-migration `<subdir>/snapshot.json`
  from each migration's own directory — the central-journal flat layout is the legacy
  pre-1.0 structure that `up` migrates away from.
- Even past that gate, the SQLite `snapshotValidator` accepts only `version: ["7"]`
  (`latestVersion = "7"`, in `api-sqlite.mjs`), so the committed `version: "6"`
  snapshots would also fail as `nonLatest`.

So a clean `generate` requires **both** the per-migration-directory layout **and**
v7 snapshot content. The only tool path that produces both is `drizzle-kit up`, which
**restructures all 15 committed migrations** into per-migration dirs and rewrites
their snapshots to v7 — a full rewrite of committed migration history.

Two facts bound the decision:

- **The format is a codegen concern, not a runtime concern.** alchemy applies the
  committed `.sql` files on deploy (`migrationsDir` in
  `apps/web/worker/db/resources.ts`); the journal/snapshot JSON is read **only** by
  drizzle-kit's diff engine (`generate`/`up`), never at apply time. The full set
  applies cleanly on real D1 (the integration tier exercises it), so the wall is
  purely about the authoring tool, not about correctness of applied schema. The only
  remaining flat-layout consumers are alchemy's `migrationsDir` (deploy) and
  `drizzle.config.ts`'s `out`; the former test-side consumer (`sqlite-d1.testing.ts`,
  a `?raw` baseline import) is gone since the test tier moved to real-D1 integration
  (ADRs [0082](0082-two-test-tiers-unit-integration.md) / [0104](0104-two-mode-integration-test-tier.md)).
- **A history rewrite collides with the in-flight authz/imge migration lane.**
  Migrations `0010_relation_tuple` … `0014_imge_object` are the capability-authz
  framework's work (epic #1228, issue #1109, ADR
  [0107](0107-capability-authz-framework.md)), which is actively adding more. Running
  `drizzle-kit up` now would rewrite those in-flight files — a direct merge collision.

### Options considered

- **(A) Bump drizzle-kit to a version whose snapshot format matches v6.** No such
  version exists going forward: `1.0.0-rc.3` *is* the new-format tool, and the flat v6
  `meta/_journal.json` layout is the legacy pre-1.0 format. Newer releases are more
  aggressive about the per-migration-dir layout, not less. Rejected — a bump cannot
  restore flat acceptance.
- **(C) Pin drizzle-kit back to a pre-1.0 (0.x) flat-compatible release.** Tooling-only
  in isolation, but `drizzle-kit` 0.x is coupled to `drizzle-orm` 0.x's schema-builder
  API, while the runtime is pinned to `drizzle-orm@1.0.0-rc.3` and `Drizzle.ts` uses
  1.0-only APIs (`defineRelations`, RQB v2). Mixing 0.x kit with 1.0 orm is
  unsupported and risks wrong codegen; downgrading the orm too would break the runtime.
  Rejected — fights the orm pin.
- **(B)/(D) Run `drizzle-kit up` to restructure + upgrade to v7.** The correct eventual
  direction, but a full rewrite of all 15 committed migrations that collides with the
  authz/imge lane and additionally requires verifying alchemy's `migrationsDir`
  recurses into per-migration subdirs. Deferred, not rejected (see Decision §3).

## Decision

1. **Hand-authored flat migrations are the sanctioned authoring path** — formalizing
   what already happens. A new migration is authored as a flat
   `worker/db/drizzle/migrations/NNNN_name.sql`, a `meta/_journal.json` entry, and a
   `meta/NNNN_*_snapshot.json`. The `.sql` is load-bearing (alchemy applies it); the
   snapshot JSON is **advisory** — it is read only by drizzle-kit's diff engine, so a
   hand-authored snapshot that is slightly off never affects applied schema.

2. **`drizzle-kit generate` is a scratch SQL aid only, never the incremental path.**
   To derive the SQL for a new table, run `generate` against an empty throwaway
   out-dir, then hand-place the emitted SQL into the flat layout. It cannot and must
   not be run incrementally against the committed history (the `assertV3OutFolder`
   gate).

3. **Defer the one-time `drizzle-kit up` cutover to v7** to a single coordinated PR,
   run only **after** the authz/imge migration lane (epic #1228 / issue #1109) settles,
   so it never rewrites in-flight migrations. This is filed as a coordinated follow-up
   and sequenced by the operator, not run per-lane. The cutover must also verify alchemy
   `migrationsDir` recurses into per-migration subdirs (and adjust the resource if not).

## Consequences

- **Now: zero tooling change, zero migration rewrite, zero collision.** No catalog
  bump, no `drizzle.config.ts` change, no touch to the committed migrations — so this
  decision does not contend with the authz/imge lane's in-flight files.
- The hand-maintained-snapshot workaround is **formalized and documented** as the
  interim path rather than retired. Retirement is deferred to the coordinated v7
  cutover (Decision §3); until then the v6 snapshots are tolerated as advisory.
- The eventual v7 cutover becomes a **tracked, coordinated single rewrite** instead of
  an each-lane foot-gun — and carries an explicit open verification item (alchemy
  per-migration-subdir recursion).
- [`.patterns/alchemy-drizzle-d1.md`](../.patterns/alchemy-drizzle-d1.md) is corrected:
  it previously claimed migration SQL is produced by `drizzle-kit generate` against the
  committed tree; it now documents hand-authoring as the path and `generate` as a
  scratch aid, pointing here for the why.
