# The preview session-signing key

`key.txt` holds the better-auth session-signing key every `pr-<n>` preview worker deploys with.

**It is preview-only, and it is public on purpose.** It is committed so any agent on any machine can
sign a preview session cookie with no setup step and no credential hand-off. Anyone who can read
this repository can forge a login on any preview deploy. That is the accepted cost, ruled by the
founder on 2026-09-21
([#9533](https://github.com/kamp-us/phoenix/issues/9533#issuecomment-5754589033)) and written down
in [ADR 0405](../../.decisions/0405-preview-workers-sign-with-a-committed-public-key.md).

**It is not the production secret and can never become one.** Production and every named stage keep
the founder-held `BETTER_AUTH_SECRET` the `infra/ci-credentials/` stack mints and pushes as a
write-only Actions secret, which no agent holds a copy of
([#9339](https://github.com/kamp-us/phoenix/issues/9339)). Two fences keep the two apart:

- `.github/workflows/deploy.yml` picks the value off the stage name. Only a stage matching `pr-<n>`
  (`isPreviewStage` in [`apps/web/worker/environment.ts`](../../apps/web/worker/environment.ts))
  deploys with this key; `prod`, `audit` and any other stage deploy with the Actions secret.
- The worker refuses at boot. `judgeAuthSecret` in
  [`apps/web/worker/preview-auth-key.ts`](../../apps/web/worker/preview-auth-key.ts) reads the
  `preview_` prefix this value carries and dies the better-auth layer when a non-`preview`
  `ENVIRONMENT` is handed a key wearing it, so a mis-keyed production deploy serves nothing rather
  than serving logins anyone can forge.

## Blast radius of a forged preview session

A preview stack is its own worker and its own D1, named `phoenix-phoenix-db-pr-<n>-…`, which holds
only the e2e suite's sign-ups and whatever `preview-seed test-account` put there — never production
rows ([ADR 0349](../../.decisions/0349-preview-seed-fence-keys-on-d1-name.md)). A cookie signed with
this key authenticates at that one preview origin and nowhere else: the production worker rejects
it by the prefix fence above, and no deployed stack outside the `pr-<n>` matrix binds it. See ADR
0405 for the full check, including the one hand-deployed worker that shares pasaport's secret.

## Rotating it

Replace the value in `key.txt` with a fresh `preview_`-prefixed high-entropy string and land it.
Previews redeploy on their next push; nothing else reads it. There is no secret store to update,
because there is no secret.
