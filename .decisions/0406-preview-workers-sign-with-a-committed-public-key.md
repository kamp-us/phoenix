---
id: 0406
title: Preview workers sign sessions with a committed public key, production with the founder-held secret
status: accepted
date: 2026-09-21
tags: [auth, preview, security, ci, review-ui, alchemy]
---

# 0406 — Preview workers sign sessions with a committed public key, production with the founder-held secret

**What this decides:** every `pr-<n>` preview worker deploys with the session-signing key committed
at `infra/preview-auth-key/key.txt`. Production, `audit` and every hand-named stage keep the
founder-held `BETTER_AUTH_SECRET`. The committed key is public on purpose and cannot reach a
non-preview stage.

## Context

One repo-wide `BETTER_AUTH_SECRET` signed sessions for every deployed worker, preview and production
alike: `infra/ci-credentials/github.ts` minted it, `deploy.yml` passed the same
`secrets.BETTER_AUTH_SECRET` into every auth-binding leg, and `apps/web/worker/config.ts` bound it
with no per-stage branch. The founder ruled on
[#9339](https://github.com/kamp-us/phoenix/issues/9339) that this value stays with him and no agent
ever gets a copy — correctly, since a copy that signs a preview session also forges a production
login for any user.

That left every `:auth` and `:auth-caylak` rendered check ending on a person. `review-ui render`
needs the key the preview worker verifies against, and the one readable copy sat behind
`$ALCHEMY_PASSWORD`, which no agent seat holds. Four lanes parked on that wall
([#9276](https://github.com/kamp-us/phoenix/issues/9276),
[#9279](https://github.com/kamp-us/phoenix/issues/9279),
[#9288](https://github.com/kamp-us/phoenix/issues/9288),
[#9423](https://github.com/kamp-us/phoenix/issues/9423)).

Two routes were on the table: commit a fixed preview key, or keep it secret and paste it onto each
machine that runs agents.

## Decision

Commit it. Founder ruling, 2026-09-21:
[#9533 comment](https://github.com/kamp-us/phoenix/issues/9533#issuecomment-5754589033) — preview
workers get their own signing key, it is committed so every agent on every machine has it with no
setup, the production secret stays founder-only, and the committed key must never be accepted by the
production worker. The accepted cost is stated there in the founder's own words: preview logins are
effectively open to anyone who reads the repo.

Zero setup on a new machine is what buys that. A per-machine paste is one manual step before any
signed-in render works, and a manual step at the start of every seat's life is exactly the shape
that turned four lanes into founder work.

## How the two keys are kept apart

Two independent fences, each of which would hold on its own.

**The deploy picks by stage name.** `.github/workflows/deploy.yml` resolves the source in its own
step and echoes which one it took, then the deploy step's `BETTER_AUTH_SECRET` reads that answer.
The predicate is `isPreviewStage` in `apps/web/worker/environment.ts` — `/^pr-\d+$/` and nothing
else. It is deliberately **not** `environmentForStage(stage) === "preview"`: that map is fail-open on
the stage axis, sending every unrecognized name to `preview`, which is right for the runtime gates it
feeds and would be wrong here — a stage somebody names by hand would be handed the public key. Under
this rule the founder-held secret is the default and the committed key is the exception, so a stage
nobody anticipated lands on the secret.

**The worker refuses to boot.** The committed key wears the `preview_` prefix, and `judgeAuthSecret`
in `apps/web/worker/preview-auth-key.ts` refuses any `preview_`-prefixed secret on any `ENVIRONMENT`
that is not `preview`. `BetterAuthLive` calls it where it holds both the secret and the environment,
and it throws: a worker that would verify forgeable sessions serves nothing rather than serving them.
The check keys on the prefix, not on the literal committed bytes, so a rotation of `key.txt` cannot
outrun it and any future preview-only key is refused off-preview for free.
`preview-auth-key.unit.test.ts` reads the real committed file and asserts it carries the prefix, so
the two cannot drift apart silently.

`audit` and `development` refuse alongside `production`. `audit` is a deployed stage on a real origin
([#1511](https://github.com/kamp-us/phoenix/issues/1511)) and `development` is a laptop that signs
with `.env`'s own throwaway, so neither has business verifying against a key the whole internet
holds.

## The blast radius, written down

**What a forged preview session reaches.** One preview origin's worker and its own per-PR D1, named
`phoenix-phoenix-db-pr-<n>-…`, which holds the e2e suite's sign-ups and whatever `preview-seed
test-account` seeded — never production rows
([ADR 0349](0349-preview-seed-fence-keys-on-d1-name.md)). So the worst case is a stranger signing in
to somebody's preview as a test user and acting as that user inside a stack that is deleted when the
PR closes.

**Who can do it.** Anyone. Preview URLs are public and the key is in the repository. This is the
accepted tradeoff, not an oversight.

**Why it stops there.** The production worker rejects a cookie signed with this key twice over: it
deploys with the founder-held secret, so the signature does not verify, and it would refuse to boot
at all if the committed key ever reached it. No preview session reaches production data, because a
preview worker is bound to its own D1 and never to production's.

**The cross-stage check the criteria asked for: does anything expect a session signed on one stage to
verify on another?** No. One place in the repo deliberately shares `BETTER_AUTH_SECRET` across
workers — `infra/depo`, whose doorman at `up.depo.kamp.us` is documented as needing a value matching
pasaport's (`infra/depo/README.md`) and reads it off `process.env` at deploy
(`infra/depo/worker/index.ts`). Three facts settle it:

- **depo is not in the `pr-<n>` matrix.** The deploy matrix comes from `.github/app-roster.json`,
  which lists `web` alone, and only `apps/web` carries an `alchemy.run.ts`. No workflow in
  `.github/workflows/` mentions depo at all; both depo stacks are hand-deployed by the founder from
  his own shell. So the stage-keyed selection never reaches it and the committed key is never
  supplied to it.
- **The sharing is production-to-production.** `depo.kamp.us` and pasaport both keep the founder-held
  secret. Nothing about that pair changes here.
- **The doorman does not verify sessions anyway.** It authenticates a presented pasaport `apiKey`
  against pasaport's own `apiKey` table (`infra/depo/worker/verifier.ts`), not a session cookie, and
  it reads the production pasaport D1. A forged preview session is not a credential it accepts in any
  form.

**One thing this does not change.** `pr-cleanup.yml` still passes `secrets.BETTER_AUTH_SECRET` into
the `alchemy destroy` of a preview stage. That is a teardown, not a serving worker — the value only
has to resolve for the config read — but it means a preview-scoped job still handles the founder-held
secret. Filed as follow-up rather than folded in here, because it is a `pull_request_target` workflow
whose teardown failing leaks a worker and a D1.

## Consequences

- A seat renders `:auth` surfaces with no credential, no flag and no environment variable.
  `review-ui render` resolves `infra/preview-auth-key/key.txt` from the checkout it stands in;
  `--auth-secret-from` still overrides, and the ambient `$BETTER_AUTH_SECRET` remains only as a
  fallback for a checkout carrying no committed key. No refusal points a seat at `$ALCHEMY_PASSWORD`
  any more, because there is nothing behind it they need.
- The ci-credentials roster is unchanged in what it mints and pushes, and its docblock now says the
  preview key is not one of its secrets.
- Rotating the preview key is a commit. There is no secret store to update, because there is no
  secret.
- Anyone reading the repository can sign in to any open PR's preview as a seeded test user. Treat a
  preview as a public sandbox, and never put a real identity or a real credential in one.
