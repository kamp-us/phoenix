# @kampus/preview-seed

Direct-D1 seed for the **preview stage's unauthenticated read flows** (issue #521).

A per-PR preview deploys a brand-new, **empty** D1, but the unauth read e2e specs
(`00-smoke`, `03-pano-feed`, `07-sozluk-term`) navigate to `/sozluk` and `/pano`
and assert on "the first term row" / "the first post" — a pre-seeded-data
assumption. This package seeds the minimum those specs need.

Per CLAUDE.md's "Sözlük seed" section, re-seed is a **direct-D1 script against the
bound database, never a runtime route on the public worker** (the admin seeder
routes were deleted as a fail-open hole). It's authored as Node tooling — an
Effect CLI (`effect/unstable/cli`), mirroring `@kampus/leak-guard` — not Python,
not an ad-hoc script.

## What it seeds

| Table             | Rows | Satisfies                                                              |
| ----------------- | ---- | --------------------------------------------------------------------- |
| `term_summary`    | 1    | `/sozluk` lists a `.kp-sozluk-term-row`; `/sozluk/<slug>` resolves     |
| `definition_record` | 2    | term page renders `.kp-sozluk-definition` cards; top one gets `--top` |
| `post_summary`    | 1    | `/pano` lists a `.kp-pano-post`; `/pano/<id>` permalink renders        |

The fixture identity is fixed (stable slugs/ids in `fixtures.ts`), so the seed is
**idempotent** — every write is an `onConflictDoUpdate` keyed on the primary key,
and the whole set lands as one atomic D1 `batch`. Re-running it never duplicates
or crashes.

## Architecture

A pure, unit-tested core + a thin Effect bin (the repo tooling idiom):

- `src/fixtures.ts` — pure fixture builder (deterministic, no I/O).
- `src/schema.ts` — the three read-model tables this writes (a narrow local copy
  of the canonical `apps/web/worker/db/drizzle/migrations` columns).
- `src/seed.ts` — idempotent upserts; runs against any `D1Database` (in-memory
  test fake or REST adapter) and also emits `{sql, params}` for the REST batch.
- `src/bin.ts` — the `preview-seed run` CLI.

## Running it

Targets a **named stage's D1** (never prod-hardcoded). #522 wires the CI
invocation after a preview deploy.

```bash
node packages/preview-seed/src/bin.ts run --database-id <stage-d1-uuid>
```

- `--database-id` (required) — the deployed stage's D1 UUID (resolve from the
  alchemy state store, or `@distilled.cloud/cloudflare/d1`'s `getDatabase`).
- `--account-id` (optional) — defaults to `$CLOUDFLARE_ACCOUNT_ID`.
- `$CLOUDFLARE_API_TOKEN` — the minted CI token (carries `D1 Write`); read by
  `CredentialsFromEnv`.

Transport is the Cloudflare D1 REST query API via alchemy's already-installed
`@distilled.cloud/cloudflare` — the same primitive alchemy uses to apply
migrations to a deployed D1, so no new Cloudflare dependency and no workerd.
