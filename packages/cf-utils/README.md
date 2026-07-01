# @kampus/cf-utils

A human-operated CLI for reading (and, in later slices, flipping) Cloudflare **Flagship**
feature flags — one traceable command surface over the flags that gate phoenix, instead of
an untraceable click in the Cloudflare dashboard.

## Why it exists

Flags today are flipped in the Cloudflare Flagship dashboard: no diff, no audit trail, no
way to see the whole `flag × env` matrix at a glance. `cf-utils` puts that read (and, in the
follow-up slices, the flip) behind a versioned, reviewable CLI. This first slice ships the
read side: enumerate every flag across every env and print the matrix.

It is a **standalone ops tool**, not a worker route — the flag IaC itself (create/delete)
stays in `apps/web/worker/features/flagship/resources.ts`; `cf-utils` only reads and (later)
flips a flag's served value.

## How it works

The load-bearing seam is the **Flagship read client** (`src/flagship.ts`): a typed Effect
service wrapping `@distilled.cloud/cloudflare`'s canonical flagship read operations
(`listApps`, `listAppFlags`, `getAppFlag`) — the *same* transport `@kampus/d1-rest` runs D1
over, so there is no new raw-`curl` client. The **env↔app mapping** is a pure, unit-tested
core (`src/flag.ts`): a Flagship app exists per stage with the physical name
`phoenix-phoenix-flags-<stage>-<suffix>`, so `decodeEnv` decodes each app's stage as its
`env` (a foreign account app decodes to no env and is skipped).

Credentials are read from the environment at runtime, never from source:
`$CLOUDFLARE_API_TOKEN` (via `CredentialsFromEnv`) + `$CLOUDFLARE_ACCOUNT_ID`. An
unreachable/unauthorized CF surfaces a typed error, not a stack trace.

## Usage

```bash
export CLOUDFLARE_API_TOKEN=<a CF token with Flagship read scope>
export CLOUDFLARE_ACCOUNT_ID=<the account to enumerate>

# List every Flagship flag × env (key, env, enabled, default value) as a table:
node src/bin.ts flag list
```

## Tests

```bash
pnpm --filter @kampus/cf-utils test        # the unit tier
pnpm --filter @kampus/cf-utils typecheck
```

The unit tier is off-network (ADR 0082): the pure decodes are tested directly, and the read
client's flag-state decode runs over a **stubbed `HttpClient`** replaying canned flagship
envelopes — no real Cloudflare.
