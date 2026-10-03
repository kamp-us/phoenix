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
- `src/test-account.ts` — the review-ui test accounts, one per audience, + their session
  and profile rows and the çaylak's optional standing (karma + kefil).
- `src/logins.ts` — the test logins as one JSON value: reading it, resolving the tokens a
  run provisions, minting a fresh set, and scrubbing tokens out of a failure.
- `src/bin.ts` — the `preview-seed run`, `preview-seed test-account` and
  `preview-seed rotate-logins` CLI.

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
PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN=<a third 32+ char secret> \
  node packages/preview-seed/src/bin.ts test-account --database-id <preview-d1-uuid>
```

The target must be a per-PR preview: the verb resolves the id's name through the
Cloudflare API first and refuses anything that is not `…-db-pr-<n>-…` (the guard
boundary below). Every write lands in one atomic D1 `batch`: a `user` row and a
`session` row per identity, plus the `(id, "moderates", "platform:platform")` tuple that is the real
moderation authority (ADR 0107 §4; `user.role` is vestigial and written only so a
coarse read agrees). Re-running it upserts the same rows, so a token is rotated by
re-running with a new one.

`review-ui render --surface /pano:auth` then signs that tier's token with the
preview worker's `$BETTER_AUTH_SECRET` and seeds it as the better-auth session
cookie. Before it records the shot it asks the preview's own
`/api/auth/get-session` from that same browser context and requires a user back at
the tier and email verification the surface named, so a token that is wrong, expired
or missing from this D1 — or a shot that came back as another audience — refuses the
render as UNKNOWN instead of filing somebody else's pixels under that surface id.

### Where the logins live — every preview is seeded on deploy

Nobody runs the command above by hand in the ordinary case. The deploy workflow
(`.github/workflows/deploy.yml`, step "Seed preview test users") runs `test-account`
against every pull request's preview right after it resolves the preview's D1 id, so
a preview can sign in as soon as it is deployed (issue #9281, rulings in #10330).

The three tokens are one JSON object, keyed by the three variable names above, and
GitHub holds it twice under the name `PREVIEW_TEST_LOGINS`:

| Copy | Who reads it | How |
| --- | --- | --- |
| Actions secret | the deploy workflow, to seed each preview | `$PREVIEW_TEST_LOGINS` in the seed step's environment |
| Repository variable | an agent that needs to sign in, never a workflow | `review-ui render` fetches it when its environment holds no token |

Access to the logins is access to the repository, and nothing is committed.
`test-account` reads `$PREVIEW_TEST_LOGINS` and an identity's own variable; the
identity's own variable wins, so a hand run can still seed one identity with a token
of its choosing.

One command sets both copies, and it is also the rotation:

```bash
node packages/preview-seed/src/bin.ts rotate-logins
```

It generates a fresh random token per identity and hands the object to
`gh secret set` and `gh variable set` on stdin, so the value is in no argument list
and is never printed. It needs a `gh` login that may write the repository's secrets
and variables, so a person holding the repo's keys runs it. Until it has been run
once the seed step skips with a notice and the deploy stays green. After a rotation
a preview already deployed keeps its old logins until its next deploy re-seeds it;
`review-ui render` reports that state as `missing session row`. If the secret is set
and the variable write fails, the command says the two disagree; re-running it
replaces both.

Every token is held in Effect's `Redacted` from the read to the one row that stores
it. GitHub masks a secret's whole value in a log and not the tokens inside the
object: its
[secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#use-secrets-for-sensitive-information)
says redaction "largely relies on finding an exact match for the specific secret
value" and that a JSON blob "significantly reduces the probability the secrets will
be properly redacted". So `test-account` never prints one, words every refusal
without quoting what it read, and reports a failed write with the tokens scrubbed
out, because the database driver reports a failed statement together with its bound
parameters: `drizzle-orm` at this repo's pin (`1.0.0-rc.5-ab785fc`) builds
`DrizzleQueryError`'s message in `errors.js` as `Failed query: <query>` followed by
`params: <params>`.

### The tier axis — one identity per audience

A tier is an audience, so one identity is not enough (issue #7398). A surface whose
whole point is that it renders *below* yazar — a çaylak nudge, a vouch prompt, a
pre-promotion affordance — is suppressed for anyone clearing the floor, so a
yazar's capture of it comes back `captured`, valid and decodable, showing the
state the PR did not add. That is the dangerous shape: a clean-looking capture of
the wrong audience.

| Identity | Tier | Email verified | Account id | Username | `moderates` tuple | Token variable | Surface state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `yazar` | `yazar` | yes | `preview-test-moderator` | `onizleme-mod` | yes | `$PREVIEW_TEST_SESSION_TOKEN` | `:auth` |
| `çaylak` | `çaylak` | yes | `preview-test-caylak` | `onizleme-caylak` | no | `$PREVIEW_TEST_CAYLAK_SESSION_TOKEN` | `:auth-caylak` |
| `çaylak-unverified` | `çaylak` | no | `preview-test-caylak-unverified` | `onizleme-caylak-dogrulanmamis` | no | `$PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN` | `:auth-caylak-unverified` |

The çaylak gets no moderation tuple, and that is the point of the tier: an identity
holding moderation authority renders a moderator's affordances whatever its `tier`
column says.

A verified email is a second axis of the audience (issue #10264). With
`phoenix-email-verified-writes` on, a çaylak whose `user.email_verified` is false is
refused the write a verified çaylak is granted, so the composer denial line renders
for that identity alone. It is a separate identity, not a flag that flips the
çaylak: a flag would make `:auth-caylak` silently render the unverified state on a
preview seeded that way.

Each provisioned identity gets three base rows, not two: `user`, `session` and
`user_profile`. The profile row is what every profile surface reads —
`Pasaport.lookupProfile` and `Pasaport.lookupProfileById` in
`apps/web/worker/features/pasaport/Pasaport.ts` both answer `null` without one, so
`/u/onizleme-mod` renders the not-found composition and the yazar's own `/profile`
has nothing to hydrate. That happens on a preview the verb reported as provisioned
(issue #9286). The profile row carries the identity's `username` and `displayName` from
the table above; a re-run updates those two and leaves `total_karma` alone, so a
standing already seeded on the preview survives a plain re-seed.

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
| *(omitted)* | none — the base profile row's `total_karma` is left where it was and `authorship_vouch` is untouched |
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
kind likewise needs the verified çaylak itself; the unverified çaylak never stands in
for it.

**Re-seeding is the capture route, so a standing is set and not accumulated.** Karma
is written, never incremented, and a run that drops the kefil deletes the vouch row
the previous run wrote. A reviewer seeds one fork, captures, re-seeds the other, and
captures again — which is why `review-ui`'s `:state` vocabulary
(`packages/fabrika-cli/src/capture/states.ts`) is untouched by this: a state token
names an *identity*, and a standing is not one.

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

That origin is a type, not a convention. `provisionTestAccounts` takes a
`ResolvedDatabaseName`, which `@kampus/d1-rest`'s `resolveDatabaseName` is the only
thing that mints, so a label a caller composed does not fit the parameter and is
refused by the compiler before any rule about its shape is applied. The shape rule
itself — `isThrowawayDatabaseName` — stays a predicate over any string, because it
answers a question about text; where the text has to have come from Cloudflare is the
fence's own signature.

**Each token is a live credential on a running preview.** Every one is read only
from the environment — its own variable or `$PREVIEW_TEST_LOGINS` — and never from
a flag, so it stays out of process listings. It must be at least 32 characters and
is refused if it carries whitespace, `;` or `,`. Give each tier a different one —
sharing a value across two identities makes a leak of either a leak of both.
`rotate-logins` does all of that and replaces the whole set.
