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

The `--execute` live-flip branch is **lever-guarded** (ADR 0133): it hard-refuses to flip a
flag live unless **both** stdin is an interactive TTY **and** an interactive `flip <flag> live?
[y/N]` confirm is affirmed (`y`/`yes`). This enforces "agents deploy, humans release" (ADR 0083)
**structurally at the tool**, not just at the `/release` skill — a TTY-less caller (an autonomous
agent or a CI runner) is refused, and there is deliberately **no override flag** (a string an
agent could pass). The guard fails toward refusal: refusing a TTY-less human is recoverable
(re-run in a terminal), while letting an agent flip live is not. The human `/release` path
satisfies the guard by construction — a human runs the lever in a terminal and confirms. Only the
`--execute` write branch is guarded; dry-run and no-op paths are unaffected.

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
source: `cf-utils auth login` stores the API token + account id once in the macOS Keychain
(via the `security` CLI — no plaintext dotfile), and `CredentialsKeychainFirst` +
`AccountIdKeychainConfig` (`src/credentials.ts`) resolve them on every later invocation,
falling back to `$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID` when the keychain has
nothing — so CI (which sets the env vars, and generally has no macOS Keychain) works
unchanged; a keychain miss is the normal CI path, not an error. `auth login` **validates
before persisting** with an authenticated `listApps` read against exactly the just-acquired
credentials, `auth status` reports what resolves from where — including **how** a keychain
token was acquired (browser OAuth vs pasted) — and whether it authenticates; `auth logout`
deletes every stored item. An unreachable/unauthorized CF surfaces a typed error, not a
stack trace.

`auth login` acquires credentials **two ways** (#1761), both persisting through the same
keychain seam:

- **Browser OAuth — `auth login --oauth`** (the `wrangler login` model): Authorization-Code
  + PKCE against Cloudflare's self-managed public OAuth clients (GA 2026-06-03). It runs a
  local loopback callback server, opens the browser to authorize, and exchanges the code for
  a short-lived **access token + refresh token** — so **no secret ever crosses the terminal**
  (the reason it exists: the token-paste flow leaks the API token on a stream/VOD). The
  resolver (`src/credentials.ts`) refreshes the access token on expiry using the stored
  refresh token, rewriting the rotated tokens back to the keychain. `src/oauth.ts` owns the
  flow; its pure core (PKCE challenge, authorize-URL build, callback validation, token-form +
  response decode) is unit-tested off-network.
- **Token paste — `auth login`** (the default, #1730): prompts for a Cloudflare API token +
  account id and stores them. The CI/headless `$CLOUDFLARE_API_TOKEN` /
  `$CLOUDFLARE_ACCOUNT_ID` env-var path is unaffected by either login mode.

### One-time founder setup — register the public PKCE OAuth client

Browser OAuth needs a **public OAuth client registered once** in the Cloudflare dashboard
(Manage account → OAuth clients) — a human setup task, done once, not something the tool
performs:

1. Create a **public client (no client secret)** — PKCE-only, as befits a CLI that can't
   hold a secret.
2. Set its **redirect URI** to `http://localhost:8976/oauth/callback` (the loopback
   `cf-utils` listens on — `OAUTH_REDIRECT_URI` in `src/oauth.ts`).
3. Grant it the **Flagship read/write scope** — the same permission the token-paste path
   uses today (Cloudflare's self-managed OAuth scope names mirror the API-token permission
   names). The scopes `cf-utils` requests live in one place, `OAUTH_SCOPES` in
   `src/oauth.ts` (`feature_flags:read`, `feature_flags:write`, `offline_access`); align them
   with what the client grants.
4. Expose the resulting **public client id** to the CLI as `$CF_UTILS_OAUTH_CLIENT_ID` (it
   is a public identifier, not a secret).

## Usage

```bash
# Once, on a human machine — authorize in the browser (no secret typed into the terminal),
# validates, stores the access + refresh token in the macOS Keychain (refreshed on expiry):
export CF_UTILS_OAUTH_CLIENT_ID=<the registered public PKCE client id>   # see founder setup above
node src/bin.ts auth login --oauth

# Or paste an API token instead — prompts for the token + account id, validates, stores it:
node src/bin.ts auth login

node src/bin.ts auth status    # where credentials resolve from (+ how acquired) + a validating read
node src/bin.ts auth logout    # remove every stored item from the keychain

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
