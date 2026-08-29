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
| `term_record`    | 1    | `/sozluk` lists a `.kp-sozluk-term-row`; `/sozluk/<slug>` resolves     |
| `definition_record` | 2    | term page renders `.kp-sozluk-definition` cards; top one gets `--top` |
| `post_record`    | 1    | `/pano` lists a `.kp-pano-post`; `/pano/<id>` permalink renders        |

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
- `src/test-account.ts` — the review-ui test account + its session row.
- `src/bin.ts` — the `preview-seed run` and `preview-seed test-account` CLI.

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

## The review-ui test account

`review-ui render` judges what renders, and until now that could only be the
anonymous view: a per-PR preview deploys an empty D1, so nothing behind login
existed to shoot and a UI delta that only appears signed in ended a review as
unseen ground reading clean (issue #7051). This verb provisions the one account
that render authenticates as.

```bash
PREVIEW_TEST_SESSION_TOKEN=<32+ char secret> \
  node packages/preview-seed/src/bin.ts test-account --database-id <preview-d1-uuid>
```

It writes three rows in one atomic D1 `batch` — the `user` row at
`moderator` + `yazar`, its `session` row carrying the supplied token, and the
`(id, "moderates", "platform:platform")` tuple that is the real moderation
authority (ADR 0107 §4; `user.role` is vestigial and written only so a coarse
read agrees). Re-running it upserts the same rows, so the token can be rotated by
re-running with a new one.

`review-ui render --surface /pano:auth` then signs that same token with the
preview worker's `$BETTER_AUTH_SECRET` and seeds it as the better-auth session
cookie. Before it records the shot it asks the preview's own
`/api/auth/get-session` from that same browser context and requires a user back,
so a token that is wrong, expired or missing from this D1 refuses the render as
UNKNOWN instead of filing the visitor's pixels under the `:auth` name.

### Forcing a dark-shipped flag needs one more grant

`review-ui render --flag <key>=on` forces a flag for the capture (issue #7218, ADR
0336) through the worker's `phoenix_flag_overrides` cookie, and a deployed stage
honors that cookie only for a request whose actor holds **platform admin** —
`moderates` is a different relation. This account is provisioned with moderation
authority and nothing more, deliberately: an ordinary `:auth` capture should show
a plain yazar+moderator's view, not an admin's affordances.

So the admin grant is a separate, opt-in step on the same throwaway preview D1,
minted offline through the sanctioned path (ADR 0107 §4):

```bash
node packages/admin-grant/src/bin.ts grant \
  --user-id preview-test-moderator --database-id <preview-d1-uuid>
```

The same guard boundary applies and is not relaxed by anything here: the target is
a throwaway preview, `override-authz.ts` is untouched, and no worker route mints
either the account or the grant.

### The guard boundary — load-bearing

**Direct-D1, never a runtime route.** Same rule as `run` above and for the same
reason: the `ENVIRONMENT`-gated `/api/admin/*` seeder routes were deleted as a
fail-open security hole (CLAUDE.md, "Sözlük seed"). Nothing in this path may be
rebuilt as a worker endpoint — an account-minting route on the public worker is
strictly worse than the seeder routes that were removed.

**Throwaway stages and previews only, and the fence is not the caller's word for
it.** A caller-asserted "this is a preview" proves nothing, so the verb reads the
target instead: a preview/stage D1 deploys empty and this package's content
fixtures denormalize their author, so a throwaway carries **no human `user` row at
all**. Finding one that is not the test identity, the verb refuses and writes
nothing — that database is somebody's real world.

Say the reach exactly, because the argument against an override flag rests on it.
The check is *no human `user` row other than the test identity*. It catches any
database anyone has ever signed into, which is every real one in practice. It does
**not** catch an empty database that is not a throwaway — a fresh apex deploy
before the first sign-up, a wiped stage, a mistyped `--database-id` that resolves
to a real-but-unpopulated D1 all pass it. The operator still owns which
`--database-id` they pass. What the fence removes is the failure that actually
happens: pointing at a live database and minting a moderator in it. There is no
override flag, and adding one would be adding back the hole the check closes.

**The token is a live moderator credential.** It is read only from
`$PREVIEW_TEST_SESSION_TOKEN` (never a flag, so it stays out of process listings),
must be at least 32 characters, and is refused if it carries whitespace, `;` or
`,`. Treat it like any other CI secret: scope it to preview, rotate it by
re-running the verb.
