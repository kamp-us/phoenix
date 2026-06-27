# @kampus/founder-seed

Offline direct-D1 CLI that mints the **founder cohort** as `(id, "moderates",
"platform")` relation tuples and lists the current founder tuples (issue #1231,
ADR [0107](../../.decisions/0107-capability-authz-framework.md)).

The `Relation` capability axis is backed by the `relation_tuple` D1 table (ADR
0107): a tuple's presence IS the grant. Founders — the existing
`role='moderator'` cohort (ADR 0098's offline grant cohort) — are minted as
`(id, "moderates", "platform")` tuples by a **server-side direct-D1 script, never
a runtime worker route** — per CLAUDE.md's "Sözlük seed" section, the admin
mutation routes were deleted as a fail-open hole, so tuple assignment is a CLI run
against the bound database by an operator who holds the D1 write token. There is no
in-product way to write a relation tuple; this package is that path for founders.

It's authored as Node tooling — an Effect CLI (`effect/unstable/cli`), mirroring
`@kampus/moderator-grant` — not Python, not an ad-hoc script.

## What it does

| Command | Effect                                                                 |
| ------- | ---------------------------------------------------------------------- |
| `seed`  | mints the `role='moderator'` cohort as `(id, "moderates", "platform")` tuples |
| `list`  | prints the current founder tuples `(subject, "moderates", "platform")` |

`seed` reports a `{founders, inserted}` count so the three outcomes read
distinctly: an empty cohort (`founders: 0, inserted: 0`), a first real seed
(`founders: N, inserted: N`), and an idempotent re-run (`founders: N, inserted:
0`). The insert is `onConflictDoNothing` against the composite primary key, so a
re-run never duplicates a founder's grant.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/seed.ts` — the pure core: `seedFounders`/`listFounderTuples` over a
  `D1Database` slice. Reads the `role='moderator'` cohort, idempotently mints the
  tuples; returns the changed-row count.
- `src/schema.ts` — the `user` + `relation_tuple` columns this touches (a narrow
  local copy of the canonical `apps/web/worker/db/drizzle/schema.ts` columns;
  `relation_tuple` is added by migration `0010_relation_tuple`).
- `src/bin.ts` — the `founder-seed seed|list` CLI; transport is the D1 REST query
  API via `@kampus/d1-rest`.

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

The founder cohort is derived from the `role='moderator'` users — grant the
moderator role first with `@kampus/moderator-grant`, then run this seed to mint the
corresponding `moderates`/`platform` tuples.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` (`@kampus/d1-rest`) — the same primitive alchemy
uses to apply migrations to a deployed D1, so no new Cloudflare dependency and no
workerd.
