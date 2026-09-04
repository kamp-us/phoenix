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
- `src/test-account.ts` — the review-ui test accounts, one per tier, + their session
  rows and the çaylak's optional standing (karma + kefil).
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
  `CredentialsFromEnv`. `test-account` also reads the database's name through it, and
  `GET /accounts/{id}/d1/database/{id}` lists `D1 Read` and `D1 Write` under
  ["Accepted Permissions (at least one required)"](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/),
  so the existing grant already covers the lookup and no new permission group is needed.

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

The target must be a per-PR preview: the verb resolves the id's name through the
Cloudflare API first and refuses anything that is not `…-db-pr-<n>-…` (the guard
boundary below). Every write lands in one atomic D1 `batch`: a `user` row and a
`session` row per tier, plus the `(id, "moderates", "platform:platform")` tuple that is the real
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

### The standing axis — where on the promotion path the çaylak sits

A tier says which audience the identity belongs to; it does not say where on the
çaylak→yazar promotion path it stands. That path forks on **vouch-exists**, and the
two forks render different compositions: `promotionBarFor` in
`apps/web/worker/features/kunye/standing.ts` returns `VOUCH_PROMOTION_KARMA_BAR` (15)
for a vouched çaylak and `KARMA_THRESHOLDS.yazar` (100) for an unvouched one, and the
unvouched composition deliberately draws no `<progress>` bar. Without a standing
operand only the second was reachable, so a PR whose payoff was the vouched
composition took a `review-ui` FAIL no change to its branch could clear (issue #7708).

`--caylak-standing` names the point:

```bash
PREVIEW_TEST_SESSION_TOKEN=<32+ char secret> \
PREVIEW_TEST_CAYLAK_SESSION_TOKEN=<a different 32+ char secret> \
  node packages/preview-seed/src/bin.ts test-account \
    --database-id <preview-d1-uuid> --caylak-standing 15+kefil
```

| Operand | Standing written |
| --- | --- |
| *(omitted)* | none — `user_profile` and `authorship_vouch` are left untouched |
| `0` | `total_karma = 0`, no kefil |
| `15+kefil` | `total_karma = 15`, vouched by the yazar test identity |

**One operand, both fields.** The karma total and the kefil travel together because a
standing carrying one without the other names no renderable state, so a partial
standing is unrepresentable at the flag as well as in the type. A spec that is not a
non-negative integer with an optional `+kefil` suffix is refused before any write.

**A vouched çaylak requires the yazar tier in the same run.** `authorship_vouch` has
no foreign keys by design (migration `0013_authorship_vouch` — an account anonymize
must not cascade-erase the historical act), so nothing in the database would catch a
`voucher_id` pointing at an identity this preview never seeded, and
`features/kunye/VouchLedger.ts` reads back on the voucher. So the run is **refused**,
not silently written, when `$PREVIEW_TEST_SESSION_TOKEN` is unset. A standing of any
kind likewise needs the çaylak tier itself.

**Re-seeding is the capture route, so a standing is set and not accumulated.** Karma
is written, never incremented, and a run that drops the kefil deletes the vouch row
the previous run wrote. A reviewer seeds one fork, captures, re-seeds the other, and
captures again — which is why `review-ui`'s `:state` vocabulary
(`packages/fabrika-cli/src/capture/states.ts`) is untouched by this: a state token
names a *tier*, and a standing is not one.

The standing rows ride the same atomic `db.batch` as the account and session rows, so
a half-written standing never reaches a capture. They change nothing about the fence
below, which reads the database's name and no row at all (ADR 0349).

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

**Per-PR previews only, and the fence is the database's name — never the caller's
word for it.** A caller-asserted "this is a preview" proves nothing, so the verb
resolves `--database-id` through the Cloudflare D1 API and reads the name the deploy
stack gave it. alchemy composes a per-PR preview as `phoenix-phoenix-db-pr-<n>-<hash>`,
so a name carrying `-pr-` is a throwaway; production (`…-db-prod-…`), a named dev
stage, and a record the API returns with no name at all are each refused before any
write.

**Why the name and not the rows.** The fence used to be emptiness — no human `user`
row other than the test identities — and it could not survive contact with CI. The
Playwright e2e job runs against the same preview D1 and signs real users up through
`/api/auth/sign-up/email`, so by the time any seat can run this verb the preview holds
dozens of human rows: the check refused every preview it was built for, and the `:auth`
/ `:auth-caylak` captures were unreachable in practice (issue #7740). The founder
ruling of 2026-09-04 re-keyed it on the name —
[#7740 comment](https://github.com/kamp-us/phoenix/issues/7740#issuecomment-5535874078).

Say the reach exactly, because the argument against an override flag rests on it.
The check is *the name Cloudflare has recorded for this database id contains `-pr-`*.
It catches every production and stage database, because none of them carries that
segment. The verb decides it before it reads either tier token, so a run against a real
database refuses on the target alone and no live preview credential is parsed into the
process first (`src/bin.ts` resolves the name and refuses ahead of `readTierToken`; the
same check runs again inside `provisionTestAccounts`, for every other caller). It does **not** catch a
database somebody deliberately named to look like a per-PR preview, and it does not
care what rows the target holds — a preview full of e2e sign-ups passes, which is the
whole point. The operator still owns which `--database-id` they pass.

**There is still no override flag, and that argument survives the re-keying
unchanged.** What the old check bought was that a caller cannot talk their way past
the fence, and that is exactly what the name keeps: the name comes back from
Cloudflare's record for the id, written by the deploy stack, so there is nothing here
for a caller to assert. A flag would hand the decision back to the caller, which is
the hole both versions of this fence exist to close.

**Each token is a live credential on a running preview.** Every one is read only
from its own environment variable (never a flag, so it stays out of process
listings), must be at least 32 characters, and is refused if it carries whitespace,
`;` or `,`. Give each tier a different one — sharing a value across two identities
makes a leak of either a leak of both. Treat them like any other CI secret: scope
them to preview, rotate one by re-running the verb.
