# @kampus/cf-utils

A human-operated CLI for reading (and, in later slices, flipping) Cloudflare **Flagship**
feature flags — one traceable command surface over the flags that gate phoenix, instead of
an untraceable click in the Cloudflare dashboard.

## Why it exists

Flags today are flipped in the Cloudflare Flagship dashboard: no diff, no audit trail, no
way to see the whole `flag × env` matrix at a glance. `cf-utils` puts the read **and the
release** behind a versioned, reviewable CLI, modeling the release the way it is actually
performed: as a **no-match percentage split** (a conditions-empty rule with a
`rollout: {percentage}`), never a `defaultVariation` flip (#1726). `defaultVariation`
stays at its create-time safe value forever — it is the no-split fallback, not the lever.

- `flag list` / `flag get` report **effective serving** (rules → no-match split → default):
  a split-released flag reads `on@100% (split)`, a ramp `on@N% (ramping)`, an unreleased
  flag `off (default)`, with a `+N targeting rules` note when targeting rules exist.
- `flag set <key> --percent N --env <env>` sets the split so N% serves `on` (the remainder
  falls to the safe default); `flag set <key> on` ≡ `--percent 100` — the human release act
  (ADR 0083, "agents deploy, humans release").
- `flag set <key> off` is a **true kill switch**: it clears the no-match split **and** sets
  `defaultVariation` off, so a split-released flag actually stops serving.

`flag set` is **dry-run by default**: it reads the current state, prints the `current →
target` diff, and writes **nothing** — the mutation happens only under an explicit
`--execute` (mirroring `orphan-sweep`), so an accidental prod release is unrepresentable.
The write is never invoked by the pipeline autonomously.

It is a **standalone ops tool**, not a worker route — the flag IaC itself (create/delete)
stays in `apps/web/worker/features/flagship/resources.ts`; `cf-utils` only reads and
releases a flag's serving state (targeting-rule and create/delete edits are out of scope).

## How it works

The load-bearing seam is the **Flagship read client** (`src/flagship.ts`, `FlagshipRead`): a
typed Effect service wrapping `@distilled.cloud/cloudflare`'s canonical flagship read
operations (`listApps`, `listAppFlags`, `getAppFlag`) — the *same* transport `@kampus/d1-rest`
runs D1 over, so there is no new raw-`curl` client. The read model round-trips `rules` (the
wire shape is the SDK's `rules[]` of `{conditions, priority, serveVariation, rollout}` —
`services/flagship.ts`), so the no-match split survives into `flag list`/`flag get`. The
release rides the sibling `FlagshipWrite` seam: its `setServing` reads the flag's current
envelope (so an unknown key fails not-found before any write), computes the next serving
state with the pure core, and re-writes it via `updateAppFlag` — no new transport. The
**env↔app mapping**, the **effective-serving computation**, and the **serving plan** are a
pure, unit-tested core (`src/flag.ts`): a Flagship app exists per stage with the physical
name `phoenix-phoenix-flags-<stage>-<suffix>`, so `decodeEnv` decodes each app's stage as
its `env` (a foreign account app decodes to no env and is skipped), `findAppForEnv` resolves
the app serving an env, `computeEffectiveServing` resolves what an env actually serves, and
`computeServingPlan`/`renderServingPlan` produce the `current → target` diff. An unknown env
fails the typed, legible `FlagEnvNotFound` before any read or write.

Credentials resolve **keychain-first with an env-var fallback** (#1730), never from
source. There are **two ways to acquire** the keychain credential and one env-var path:

- **Browser OAuth** (`auth login --oauth`, #1761) — the `wrangler login` model:
  Authorization-Code + PKCE, a local loopback callback, CSRF `state`, PKCE challenge. You
  authorize in the browser, so **no API-token secret ever crosses the terminal** — the path
  that is safe to run on a stream (a pasted token would leak on a Twitch VOD). It stores an
  **expiring access token + a refresh token**; `CredentialsKeychainFirst` resolves it via the
  SDK's `fromOAuth` provider and **refreshes on expiry**, persisting the renewed set back to
  the keychain.
- **Token paste** (`auth login`, the default, #1730) — prompts for a Cloudflare API token +
  account id, **validates before persisting** with an authenticated `listApps` read against
  exactly the pasted credentials, and stores the long-lived token. This is the
  **full-coverage** path (see the OAuth scope caveat below) and is **not** deprecated.
- **Env vars** (`$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID`) — the CI/headless path,
  used on a keychain miss. Byte-for-byte unchanged.

Resolution precedence is OAuth (keychain) → pasted token (keychain) → env. A keychain miss is
the normal CI path, not an error. `auth status` reports what resolves from where — `oauth |
keychain | env | missing` — and whether it authenticates; `auth logout` deletes every stored
item (token-paste and OAuth). An unreachable/unauthorized CF surfaces a typed error, not a
stack trace.

### One-time founder setup — register the public PKCE OAuth client

The OAuth flow needs a **public (PKCE, no client secret) OAuth client** registered once in the
Cloudflare dashboard — a **human setup task**, not something the tooling performs:

1. Cloudflare dashboard → **Manage account → OAuth clients → Create**.
2. Choose a **public / PKCE client** (no client secret — a CLI cannot hold one).
3. Set the redirect/callback URI to **`http://localhost:9976/auth/callback`** (the loopback the
   local callback server listens on — `OAUTH_REDIRECT_URI` in `src/oauth.ts`).
4. Grant it a scope covering **Flagship read + write** (plus `account:read` / `user:read` for
   account enumeration, and `offline_access` for the refresh token).
5. The resulting **public client id** is wired as `OAUTH_CLIENT_ID` in `src/oauth.ts`; if the
   founder registers under a different client id, update that constant.

> **OAuth scope caveat (pending confirmation).** OAuth scope names map 1:1 to Cloudflare
> API-token permission names. As of writing, **no `flagship:*` (feature-flag) scope is
> documented** in Cloudflare's published OAuth-scope catalog (verified against the
> wrangler/alchemy scope list). The scopes this flow requests are therefore a **single,
> documented config constant** — `FLAGSHIP_OAUTH_SCOPES` in `src/oauth.ts` — currently
> `flagship:read` / `flagship:write` (best-guess names following CF's `<resource>:<verb>`
> convention). **The founder must confirm the real Flagship scope id via the dashboard's
> `GET /oauth/scopes`.** If Cloudflare does not expose a Flagship OAuth scope, OAuth is a
> **partial / scope-down** path (it covers what it can) and **token-paste remains the
> full-coverage path** — which is exactly why token-paste stays a first-class login mode, not a
> deprecated one. Correcting the scope is a **one-line edit** to `FLAGSHIP_OAUTH_SCOPES`, no
> refactor.

## Usage

```bash
# Once, on a human machine — stores credentials in the macOS Keychain; every later
# invocation resolves them automatically.

# Browser OAuth (no secret in the terminal — safe on a stream; needs the one-time client above):
node src/bin.ts auth login --oauth

# Or token paste (prompts for the token + account id, validates, stores — full-coverage path):
node src/bin.ts auth login

node src/bin.ts auth status    # where credentials resolve from (oauth|keychain|env|missing) + a validating read
node src/bin.ts auth logout    # remove them (token-paste and OAuth) from the keychain

# Or the env-var path (CI, or any non-macOS host):
export CLOUDFLARE_API_TOKEN=<a CF token with Flagship read scope>
export CLOUDFLARE_ACCOUNT_ID=<the account to enumerate>

# List every Flagship flag × env (key, env, enabled, EFFECTIVE serving) as a table:
node src/bin.ts flag list

# Dry-run a full release — print the current → target diff, write nothing:
node src/bin.ts flag set authorship-loop on --env prod

# Apply it (the human release act; on ≡ --percent 100, the canonical split form):
node src/bin.ts flag set authorship-loop on --env prod --execute

# Ramp to 50% (no-match split serves on to half the traffic):
node src/bin.ts flag set authorship-loop --percent 50 --env prod --execute

# Kill switch — clear the split AND set the default off (actually stops a split release):
node src/bin.ts flag set authorship-loop off --env prod --execute
```

## Tests

```bash
pnpm --filter @kampus/cf-utils test        # the unit tier
pnpm --filter @kampus/cf-utils typecheck
```

The unit tier is off-network (ADR 0082): the pure decodes are tested directly, and the read
client's flag-state decode runs over a **stubbed `HttpClient`** replaying canned flagship
envelopes — no real Cloudflare.
