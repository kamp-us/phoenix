# @kampus/founder-seed

Offline direct-D1 CLI that mints the **founding author-mod cohort** as both
`moderator` and `yazar`, and lists the current founder tuples (issues #1231/#1207,
ADR [0107](../../.decisions/0107-capability-authz-framework.md)).

The founding cohort writes the seed corpus *and* holds promotion authority — "earning
mod later" is North Star, so for v1 mod is fused into this cohort. The seed establishes
each founder as:

- **moderator** — the legacy `user.role` column (ADR 0098) **and** the
  `(id, "moderates", "platform:platform")` relation tuple on the `Relation` axis (ADR
  0107). A tuple's presence IS the capability grant; the column is the coarse role read.
- **yazar** — the server-managed `user.tier` (#1203), the top of the stored
  `çaylak < yazar` authorship ladder.

It runs as a **server-side direct-D1 script, never a runtime worker route** — per
CLAUDE.md's "Sözlük seed" section, the admin mutation routes were deleted as a fail-open
hole, so this is a CLI run against the bound database by an operator who holds the D1
write token. There is no in-product way to write a relation tuple or set a tier; this
package is that path for founders.

The cohort is **data, not logic**: `src/cohort.ts` exports `FOUNDER_COHORT`, an editable
list of founder `user.id`s the seed reads. The ~20 names are added there without touching
the seed core; an **empty** roster makes the seed a clean no-op.

The `object` key is `@kampus/authz`'s canonical `key(platform)` (`"platform:platform"`)
— the SAME encoding the worker's `RelationStoreLive` reads with, so a seeded founder
discharges `Moderate.over(platform)` end to end (the write→read seam).

It's authored as Node tooling — an Effect CLI (`effect/unstable/cli`), mirroring
`@kampus/moderator-grant` — not Python, not an ad-hoc script.

## What it does

| Command | Effect                                                                              |
| ------- | ----------------------------------------------------------------------------------- |
| `seed`  | promotes `FOUNDER_COHORT` to `moderator` (role + `moderates` tuple) and `yazar` (tier) |
| `list`  | prints the current founder tuples `(subject, "moderates", "platform:platform")`     |

`seed` reports `{cohort, matched, promoted, inserted}` so the outcomes read distinctly:
an empty roster (`cohort: 0`), a first real seed (`promoted: N, inserted: N`), and an
idempotent re-run (`promoted: 0, inserted: 0`). The promotion `UPDATE` is guarded to skip
a row already at `(moderator, yazar)` and only ever targets the ladder tops, so a re-run
neither rewrites nor **downgrades** a founder; the tuple `INSERT` is `onConflictDoNothing`
against the composite primary key, so a re-run never duplicates a grant. A roster id with
no `user` row is skipped — never a phantom promotion or an orphan tuple.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/cohort.ts` — `FOUNDER_COHORT`, the editable founder roster (data, not logic).
- `src/seed.ts` — the pure core: `seedFounders`/`listFounderTuples` over a `D1Database`
  slice. Reads the cohort, idempotently promotes the rows + mints the tuples; returns the
  changed-row counts.
- `src/schema.ts` — the `user` (`id` + `role` + `tier`) + `relation_tuple` columns this
  touches (a narrow local copy of the canonical `apps/web/worker/db/drizzle/schema.ts`
  columns; `relation_tuple` is added by migration `0010_relation_tuple`, `tier` by
  `0011_authorship_tier`).
- `src/bin.ts` — the `founder-seed seed|list` CLI; transport is the D1 REST query API
  via `@kampus/d1-rest`.

## Running it

Targets a **named stage's D1** (never prod-hardcoded).

```bash
node packages/founder-seed/src/bin.ts seed --database-id <stage-d1-uuid>
node packages/founder-seed/src/bin.ts list --database-id <stage-d1-uuid>
```

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — the minted token (carries `D1 Write`); read by
  `CredentialsFromEnv`.

The cohort is named in `src/cohort.ts` (`FOUNDER_COHORT`) — each founder's `user.id`
for an already-registered account. The seed promotes those accounts; it does not create
users, so the founders must exist before it runs.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` (`@kampus/d1-rest`) — the same primitive alchemy
uses to apply migrations to a deployed D1, so no new Cloudflare dependency and no
workerd.
