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
- `src/test-account.ts` — the review-ui test accounts, one per tier, + their session rows.
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

## The review-ui test accounts

`review-ui render` judges what renders, and until now that could only be the
anonymous view: a per-PR preview deploys an empty D1, so nothing behind login
existed to shoot and a UI delta that only appears signed in ended a review as
unseen ground reading clean (issue #7051). This verb provisions the accounts that
render authenticates as.

```bash
PREVIEW_TEST_SESSION_TOKEN=<32+ char secret> \
PREVIEW_TEST_CAYLAK_SESSION_TOKEN=<a different 32+ char secret> \
  node packages/preview-seed/src/bin.ts test-account --database-id <preview-d1-uuid>
```

Every write lands in one atomic D1 `batch`: a `user` row and a `session` row per
tier, plus the `(id, "moderates", "platform:platform")` tuple that is the real
moderation authority (ADR 0107 §4; `user.role` is vestigial and written only so a
coarse read agrees). Re-running it upserts the same rows, so a token is rotated by
re-running with a new one.

`review-ui render --surface /pano:auth` then signs that tier's token with the
preview worker's `$BETTER_AUTH_SECRET` and seeds it as the better-auth session
cookie. Before it records the shot it asks the preview's own
`/api/auth/get-session` from that same browser context and requires a user back at
the tier the surface named, so a token that is wrong, expired or missing from this
D1 — or a shot that came back as another tier — refuses the render as UNKNOWN
instead of filing somebody else's pixels under that surface id.

### The tier axis — one identity per audience

A tier is an audience, so one identity is not enough (issue #7398). A surface whose
whole point is that it renders *below* yazar — a çaylak nudge, a vouch prompt, a
pre-promotion affordance — is suppressed for anyone clearing the floor, so a
yazar's capture of it comes back `captured`, valid and decodable, showing the
state the PR did not add. That is the dangerous shape: a clean-looking capture of
the wrong audience.

| Tier | Account id | Username | `moderates` tuple | Token variable | Surface state |
| --- | --- | --- | --- | --- | --- |
| `yazar` | `preview-test-moderator` | `onizleme-mod` | yes | `$PREVIEW_TEST_SESSION_TOKEN` | `:auth` |
| `çaylak` | `preview-test-caylak` | `onizleme-caylak` | no | `$PREVIEW_TEST_CAYLAK_SESSION_TOKEN` | `:auth-caylak` |

The çaylak gets no moderation tuple, and that is the point of the tier: an identity
holding moderation authority renders a moderator's affordances whatever its `tier`
column says.

**A tier with no token is left unseeded, and nothing substitutes for it.** This verb
seeds exactly the tiers whose variable is set and names the rest in its output; a
run with none set refuses rather than picking a default. On the capture side the
same variable is the fence: `review-ui render` refuses a surface naming a tier whose
token is unset — on `11`, before a browser launches — instead of falling back to the
seeded identity. The two lists are hand-kept in step, here and in `fabrika-cli`'s
`src/capture/auth.ts`.

### Forcing a dark-shipped flag needs one more grant

`review-ui render --flag <key>=on` forces a flag for the capture (issue #7218, ADR
0336) through the worker's `phoenix_flag_overrides` cookie, and a deployed stage
honors that cookie only for a request whose actor holds **platform admin** —
`moderates` is a different relation. Neither account is provisioned with admin,
deliberately: an ordinary tier capture should show that tier's plain view, not an
admin's affordances.

So the admin grant is a separate, opt-in step on the same throwaway preview D1,
minted offline through the sanctioned path (ADR 0107 §4), against whichever tier's
account the run renders as:

```bash
node packages/admin-grant/src/bin.ts grant \
  --user-id preview-test-moderator --database-id <preview-d1-uuid>
```

Admin is a relation tuple and not a tier, so a granted `preview-test-caylak` is
still a çaylak and the render's tier proof still binds.

The same guard boundary applies and is not relaxed by anything here: the target is
a throwaway preview, `override-authz.ts` is untouched, and no worker route mints
either the accounts or the grant.

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
all**. Finding one that is none of the test identities, the verb refuses and writes
nothing — that database is somebody's real world.

**The tier axis widens the identity list and nothing else.** Every seeded tier is
excluded from that count, which is what keeps a re-run idempotent once both are on
the D1 — a check that knew only one of them would call the other somebody's real
world and refuse every subsequent run. It excludes exactly the fixed ids in the
table above, so it does not admit one further row.

Say the reach exactly, because the argument against an override flag rests on it.
The check is *no human `user` row other than the test identities*. It catches any
database anyone has ever signed into, which is every real one in practice. It does
**not** catch an empty database that is not a throwaway — a fresh apex deploy
before the first sign-up, a wiped stage, a mistyped `--database-id` that resolves
to a real-but-unpopulated D1 all pass it. The operator still owns which
`--database-id` they pass. What the fence removes is the failure that actually
happens: pointing at a live database and minting a moderator in it. There is no
override flag, and adding one would be adding back the hole the check closes.

**Each token is a live credential on a running preview.** Every one is read only
from its own environment variable (never a flag, so it stays out of process
listings), must be at least 32 characters, and is refused if it carries whitespace,
`;` or `,`. Give each tier a different one — sharing a value across two identities
makes a leak of either a leak of both. Treat them like any other CI secret: scope
them to preview, rotate one by re-running the verb.
