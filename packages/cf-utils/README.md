# @kampus/cf-utils

A human-operated CLI over Cloudflare + phoenix's D1: reading (and, in later slices, flipping)
**Flagship** feature flags — one traceable command surface over the flags that gate phoenix,
instead of an untraceable click in the Cloudflare dashboard — plus founder-side, direct-D1
**data-scrub** verbs run with prod oversight (never a runtime worker route).

> Naming: the cf-utils → anka-ops rename is tracked separately (#2089). Functionality grows
> here now; the rename lands later.

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

## `scrub-author-email` — remove email-at-rest from `author_name` (#2137)

`scrub-author-email` is a founder-side, one-off data-scrub verb that removes leaked emails
from the denormalized `author_name` column on the three record tables (`definition_record` /
`post_record` / `comment_record`). It is the data-backfill remediation of the #2130 PII-at-rest
leak: the old `authorName: user.name ?? user.email` write-fallback persisted a null-name
account's **email** into a publicly-rendered column; #2136 stopped new email-bearing writes,
and this verb scrubs the rows persisted *before* that fix. It is delivered as a **CLI verb over
the D1 REST transport** (`@kampus/d1-rest`, credentialed by the same keychain seam) — **never** a
runtime worker route: a public/`ENVIRONMENT`-gated admin/seeder endpoint is exactly the deleted
fail-open hole (the removed `/api/admin/*` seeder routes).

Two invariants are load-bearing:

- **Destructive ceremony — dry-run by default.** The verb **scans and prints per-table affected
  counts only** — never the email values (leak-clean output: the count is the signal a founder
  needs to size the blast radius, the PII is what the output must never re-print). A write happens
  **only** under an explicit confirm-and-name gate: **`--execute` AND `--confirm
  scrub-author-email`**. No `--execute`, or a missing/wrong `--confirm` name, stays a dry-run —
  there is no write-by-default and no single-flag write. A zero-count scan is a first-class
  "nothing to scrub" (the #2137 close-as-done path).
- **SQL grounded vs real D1 (ADR 0082).** D1 is SQLite-over-REST, so every clause is core SQLite:
  the email-shaped predicate is `author_name LIKE '%_@_%_._%'` (a full `local@domain.tld` shape,
  so a display name that merely contains an `@` is not over-scrubbed), and the replacement label
  is recomputed **in SQL** by mirroring `authorDisplayLabel`
  (`apps/web/worker/features/pasaport/author-label.ts`) —
  `COALESCE(NULLIF(TRIM(name),''), '@'||NULLIF(TRIM(username),''), 'kullanıcı')` joined on
  `author_id = user.id`. The BetterAuth `user` table lives on the **same** shared `PhoenixDb` D1
  as the record tables (ADR 0009), so the identity JOIN resolves in one query. `LIKE`, `COALESCE`,
  `NULLIF`, `TRIM`, and `||` are all core SQLite (present in D1). Because `author_name` is
  `.notNull()`, the scrub **rewrites** the value to the recomputed label — it never nulls the
  column and never deletes a row; and since the recomputed label is never email-shaped, re-running
  is idempotent.

Building the verb needs **no credentials** and ships through the normal pipeline; **running** it
needs a token carrying D1:edit on the cf-utils keychain (a founder-side act against prod, with
oversight and post-run verification — the CLI's build must not, and does not, run against prod).

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
source: `cf-utils auth login` prompts for a Cloudflare API token + account id and stores
them once in the macOS Keychain (via the `security` CLI — no plaintext dotfile), and
`CredentialsKeychainFirst` + `AccountIdKeychainConfig` (`src/credentials.ts`) resolve them
on every later invocation, falling back to `$CLOUDFLARE_API_TOKEN` /
`$CLOUDFLARE_ACCOUNT_ID` when the keychain has nothing — so CI (which sets the env vars, and
generally has no macOS Keychain) works unchanged; a keychain miss is the normal CI path, not
an error. `auth login` **validates before persisting** with an authenticated `listApps` read
against exactly the just-acquired credentials, `auth status` reports what resolves from where
and whether it authenticates, and `auth logout` deletes every stored item. The secret rides
the `Prompt.password` prompt and the keychain — never argv, shell history, or a dotfile. An
unreachable/unauthorized CF surfaces a typed error, not a stack trace.

## Usage

```bash
# Once, on a human machine — paste an API token: prompts for the token + account id,
# validates it with an authenticated read, then stores it in the macOS Keychain:
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

# Scrub email-at-rest from author_name — DRY-RUN by default: scan + print per-table counts,
# write nothing (the counts are leak-clean; no email value is ever printed):
node src/bin.ts scrub-author-email --database-id <the target stage's D1 uuid>

# Apply it — requires BOTH --execute AND the op name; anything less stays a dry-run:
node src/bin.ts scrub-author-email --database-id <uuid> --execute --confirm scrub-author-email
```

## Tests

```bash
pnpm --filter @kampus/cf-utils test        # the unit tier
pnpm --filter @kampus/cf-utils typecheck
```

The unit tier is off-network (ADR 0082): the pure decodes are tested directly, and the read
client's flag-state decode runs over a **stubbed `HttpClient`** replaying canned flagship
envelopes — no real Cloudflare.
