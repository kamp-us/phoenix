# CI/CD — deploy from GitHub Actions

How phoenix ships from CI. Pushes to `main` deploy the `prod` stage; pull requests
get an isolated `pr-<n>` preview with its own worker + D1 + DOs; closing a PR tears
that stage down. Adapted from [alchemy tutorial Part 5](https://v2.alchemy.run/tutorial/part-5/)
to phoenix's stack (pnpm + node, not bun).

The trick — and the reason this isn't just "paste your Cloudflare key into GitHub" —
is that alchemy **provisions its own CI credentials**: a one-shot `stacks/github.ts`
mints a *scoped* Cloudflare API token and writes it (plus the account id and the
state password) into the repo's Actions secrets, all from code.

## The pieces

| File | Role |
|---|---|
| [`apps/web/stacks/github.ts`](../apps/web/stacks/github.ts) | One-shot, run from your laptop under an `admin` profile. Mints the scoped CI token + a stable `BETTER_AUTH_SECRET` and pushes the four repo secrets. |
| [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | `deploy` job (push→`prod`, PR→`pr-<n>`) + `cleanup` job (PR close→`destroy`). |

## The CI secret set

`stacks/github.ts` provisions exactly what the workflow consumes:

| Secret | Why |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The minted token, scoped to Workers Scripts / KV / D1 / Tail / Account-Settings-Read. Never echoed to your shell — piped from `AccountApiToken.value` straight into `GitHub.Secret`. |
| `CLOUDFLARE_ACCOUNT_ID` | Which account to deploy into. |
| `ALCHEMY_PASSWORD` | Encrypts/decrypts secrets in the Cloudflare-hosted alchemy state store. |
| `BETTER_AUTH_SECRET` | The session-signing secret. The worker reads it at runtime as a `secret_text` binding (`config.ts`: `Config.redacted("BETTER_AUTH_SECRET")`), so `alchemy deploy` needs the value. `stacks/github.ts` mints a stable `Random` (persisted in its state) and pushes it. |

> **`BETTER_AUTH_SECRET` is a deploy-time binding value, not Random-in-the-app-stack.**
> The worker reads it from the runtime env (`config.ts`); `Random` is a deploy-time
> resource with no value in the workerd isolate, so it can't be the runtime source.
> `stacks/github.ts` mints it once (stable across re-runs) and pushes it as a repo
> secret; the deploy passes it through so the worker binds it.

## Bootstrap (run once, by a human)

The app deploy only needs enough Cloudflare permission to ship the worker. Minting a
*new* token needs the elevated `API Tokens > Write` permission — so keep that on a
dedicated profile, not your day-to-day one.

```bash
# 1. Log in with a credential that can mint tokens (Global API Key is simplest) +
#    a GitHub credential (gh-cli or a PAT with `repo`).
alchemy login --profile admin

# 2. Deploy the one-shot. It mints the scoped CF token + a stable BETTER_AUTH_SECRET
#    and pushes all four repo secrets. ALCHEMY_PASSWORD is the state-encryption
#    password; reuse the same value the app stack deploys with.
CLOUDFLARE_ACCOUNT_ID=<account-id> ALCHEMY_PASSWORD=<password> \
  pnpm --filter @phoenix/web exec alchemy deploy stacks/github.ts \
    --profile admin --yes
```

Check **Settings → Secrets and variables → Actions**: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `ALCHEMY_PASSWORD`, and `BETTER_AUTH_SECRET` should be
listed. Re-run only to rotate the token or change its scope — the remote
`Cloudflare.state()` tracks the token's id (and the minted secret), so a rescope is
a clean diff, not an orphaned token.

## Gotchas baked into the files

- **`exec alchemy`, not the package script.** `pnpm --filter @phoenix/web deploy --stage X`
  makes *pnpm* swallow `--stage`/`--yes` (`Unknown options: 'stage', 'yes'`). The
  workflow builds the SPA, then runs `pnpm --filter @phoenix/web exec alchemy deploy
  --stage "$STAGE" --yes` so the flags reach the alchemy CLI.
- **`--yes` is required in CI.** Without it, alchemy prompts for plan approval on any
  change and the job hangs.
- **`STAGE` regex.** Stage names must match `^[a-z0-9]([-_a-z0-9]*)$` — `pr-12` and
  `prod` both pass.
- **`BETTER_AUTH_SECRET` at deploy AND destroy.** `config.ts` reads it `Effect.orDie`,
  so both `deploy` and `destroy` (which loads `alchemy.run.ts` to build the worker
  layer) need it in env, not just the deploy.
- **Prod safety check.** The `cleanup` job refuses to `destroy` if `STAGE == prod`,
  even though it only ever runs on closed PRs.

## See also

- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — the stack, stages, dev vs deploy
- [alchemy-overview.md](./alchemy-overview.md) — what alchemy replaces and why
