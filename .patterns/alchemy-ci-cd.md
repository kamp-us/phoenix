# CI/CD — deploy from GitHub Actions

How phoenix ships from CI. Pushes to `main` deploy the `prod` stage; pull requests
get an isolated `pr-<n>` preview with its own worker + D1 + DOs; closing a PR tears
that stage down. Adapted from [alchemy tutorial Part 5](https://v2.alchemy.run/tutorial/part-5/)
to phoenix's stack (pnpm + node, not bun).

phoenix is multi-app/multi-worker (ADR [0057](../.decisions/0057-multi-app-multi-worker-repo.md)):
each app under `apps/` is its own package + alchemy stack + per-app stage. The deploy
workflow **fans out over every app via an `app` matrix** — one matrix leg per app, each
building and deploying *that* app's stack to the shared `prod`/`pr-<n>` stage convention.
All legs reuse the same four account-global CI secrets and the one state store; adding an
app is one more `include:` entry, not a second bootstrap.

Authored by [Can Sirin](https://github.com/cansirin) in #19, landed with the framework foundation in #12.

The trick — and the reason this isn't just "paste your Cloudflare key into GitHub" —
is that alchemy **provisions its own CI credentials**: a one-shot `infra/ci-credentials/github.ts`
(the standalone `@kampus/infra` package) mints a *scoped* Cloudflare API token and
writes it (plus the account id and the state password) into the repo's Actions
secrets, all from code.

## The pieces

| File | Role |
|---|---|
| [`infra/ci-credentials/github.ts`](../infra/ci-credentials/github.ts) | One-shot in the standalone `@kampus/infra` package, run from your laptop under an `admin` profile. Mints the scoped CI token + a stable `BETTER_AUTH_SECRET` and pushes the repo secrets. Repo-level infra — owned by neither app (ADR [0057](../.decisions/0057-multi-app-multi-worker-repo.md)). |
| [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | `deploy` job (push→`prod`, PR→`pr-<n>`) + `cleanup` job (PR close→`destroy`), both matrixed over every app (`web`, `dashboard`). |

## The CI secret set

`infra/ci-credentials/github.ts` provisions exactly what the workflow consumes:

| Secret | Why |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The minted token, scoped to Workers Scripts / KV / D1 / Tail / Account-Settings-Read / **Secrets-Store-Read+Write** (the last pair is what `Cloudflare.state()` needs to adopt its state-store worker's bearer token + encryption key on every deploy — omit them and the deploy fails with Cloudflare error 10000). Never echoed to your shell — piped from `AccountApiToken.value` straight into `GitHub.Secret`. |
| `CLOUDFLARE_ACCOUNT_ID` | Which account to deploy into. |
| `ALCHEMY_PASSWORD` | Encrypts/decrypts secrets in the Cloudflare-hosted alchemy state store. |
| `BETTER_AUTH_SECRET` | The session-signing secret. The worker reads it at runtime as a `secret_text` binding (`config.ts`: `Config.redacted("BETTER_AUTH_SECRET")`), so `alchemy deploy` needs the value. `infra/ci-credentials/github.ts` mints a stable `Random` (persisted in its state) and pushes it. |
| `DASHBOARD_GITHUB_TOKEN` | The GitHub token `@kampus/dashboard`'s worker binds (`secret_text`) for authenticated reads of `kamp-us/phoenix` issues (`apps/dashboard/worker/config.ts`: `Config.redacted("GITHUB_TOKEN")`, no default → required at deploy). Provisioned by `infra/ci-credentials/github.ts` like the others, but **supplied**, not minted: pass a fine-grained PAT (Issues: read) as `DASHBOARD_GITHUB_TOKEN` on the one-shot's env (a GitHub PAT can't be self-issued the way the Cloudflare token is). Stored under this name because Actions forbids a secret named `GITHUB_TOKEN`; the workflow maps it to the `GITHUB_TOKEN` env for the `dashboard` matrix legs only (`matrix.needs-github-token`). |

> **`BETTER_AUTH_SECRET` is a deploy-time binding value, not Random-in-the-app-stack.**
> The worker reads it from the runtime env (`config.ts`); `Random` is a deploy-time
> resource with no value in the workerd isolate, so it can't be the runtime source.
> `infra/ci-credentials/github.ts` mints it once (stable across re-runs) and pushes it as a repo
> secret; the deploy passes it through so the worker binds it.

## Bootstrap (run once, by a human)

The app deploy only needs enough Cloudflare permission to ship the worker. Minting a
*new* token needs the elevated `API Tokens > Write` permission — so keep that on a
dedicated profile, not your day-to-day one.

```bash
# 1. Log in with a credential that can mint tokens (Global API Key is simplest) +
#    a GitHub credential (gh-cli or a PAT with `repo`).
alchemy login --profile admin

# 2. Provision the Cloudflare-hosted state store (a Worker+DO that holds alchemy
#    state). Required once per account before any `Cloudflare.state()` deploy.
#    Subcommand order is `alchemy cloudflare bootstrap`, NOT `alchemy bootstrap
#    cloudflare` (the "State store not found" error suggests the wrong form).
pnpm --filter @kampus/infra exec alchemy cloudflare bootstrap --profile admin

# 3. Deploy the one-shot. It mints the scoped CF token + a stable BETTER_AUTH_SECRET
#    and pushes all repo secrets. ALCHEMY_PASSWORD is the state-encryption password
#    (reuse the value the app stack deploys with); DASHBOARD_GITHUB_TOKEN is a
#    fine-grained GitHub PAT (Issues: read on kamp-us/phoenix) you mint by hand —
#    it's the one secret supplied rather than minted (a PAT can't be self-issued).
CLOUDFLARE_ACCOUNT_ID=<account-id> ALCHEMY_PASSWORD=<password> DASHBOARD_GITHUB_TOKEN=<pat> \
  pnpm --filter @kampus/infra exec alchemy deploy github.ts \
    --profile admin --yes
```

Check **Settings → Secrets and variables → Actions**: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `ALCHEMY_PASSWORD`, `BETTER_AUTH_SECRET`, and
`DASHBOARD_GITHUB_TOKEN` should be listed. Re-run only to rotate the token/scope or
the dashboard PAT — the remote `Cloudflare.state()` tracks the token's id (and the
minted secret), so a rescope is a clean diff, not an orphaned token.

## Gotchas baked into the files

- **CI never uses an alchemy profile.** The `admin` profile is laptop-only
  (`~/.alchemy/profiles.json`, with the elevated token-minting + GitHub creds). CI
  authenticates purely via the env-var `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` +
  `ALCHEMY_PASSWORD` secrets — do **not** set `ALCHEMY_PROFILE` in the workflow.
- **The state store is versioned; re-bootstrap on alchemy bumps.** A `Cloudflare.state()`
  deploy fails with `Cloudflare State store not found … run 'alchemy … bootstrap'` when the
  account's state-store worker is out of date (e.g. alchemy `beta.52` expects store **v7**,
  `beta.45` used **v6**). Re-run the `alchemy cloudflare bootstrap --profile admin` step
  above to upgrade it in place. The upgrade is **account-global and one-way**, so once you
  bump, branches still on the older alchemy can no longer deploy against that account.
- **`exec alchemy`, not the package script.** `pnpm --filter @kampus/web deploy --stage X`
  makes *pnpm* swallow `--stage`/`--yes` (`Unknown options: 'stage', 'yes'`). The
  workflow builds the SPA, then runs `pnpm --filter @kampus/web exec alchemy deploy
  --stage "$STAGE" --yes` so the flags reach the alchemy CLI.
- **`--yes` is required in CI.** Without it, alchemy prompts for plan approval on any
  change and the job hangs.
- **`STAGE` regex.** Stage names must match `^[a-z0-9]([-_a-z0-9]*)$` — `pr-12` and
  `prod` both pass.
- **`BETTER_AUTH_SECRET` is per-app, at deploy AND destroy.** An app that binds it
  (`@kampus/web`, whose `config.ts` reads it `Effect.orDie`) needs it in env for both
  `deploy` and `destroy` (`destroy` loads `alchemy.run.ts` to build the worker layer),
  not just the deploy. An auth-less app (`@kampus/dashboard`, whose `config.ts` reads
  only `ENVIRONMENT`) must **not** require it — the matrix's `needs-auth` flag passes the
  secret only for legs that bind it (`matrix.needs-auth && secrets.BETTER_AUTH_SECRET || ''`),
  so the dashboard deploys without ever touching auth state.
- **Prod safety check.** The `cleanup` job refuses to `destroy` if `STAGE == prod`,
  even though it only ever runs on closed PRs. It runs per matrix leg, so each app's
  preview-stage teardown is independently guarded.
- **One sticky comment, both URLs.** The PR preview comment is a single sticky comment
  keyed by `<!-- preview-deploy -->`, with a per-app sub-line keyed by
  `<!-- preview-deploy:<app> -->`. Parallel matrix legs each upsert only their own
  app's line via an optimistic read-modify-write (re-read + retry on conflict), so both
  apps' URLs land in the one comment without a leg clobbering the other's.

## See also

- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — the stack, stages, dev vs deploy
- [alchemy-overview.md](./alchemy-overview.md) — what alchemy replaces and why
