---
id: 0137
title: e2e harness gains privileged D1 REST to promote a user to yazar
status: accepted
date: 2026-07-03
tags: [e2e, testing, ci, github-actions, d1, kunye]
---

# 0137 — e2e harness gains privileged D1 REST to promote a user to yazar

## Context

Resolves triaged issue [#1838](https://github.com/kamp-us/phoenix/issues/1838), and
unblocks [#1828](https://github.com/kamp-us/phoenix/issues/1828) (the "earn to vote"
anti-manipulation vote-gate, child of investigation
[#1705](https://github.com/kamp-us/phoenix/issues/1705)).

#1828 gates pano/sözlük vote-casting **above the çaylak newcomer tier**: `Vote.castImpl`
now requires `authorshipLadder.gte(tier, "yazar")` (`apps/web/worker/features/kunye/standing.ts`,
ADR [0107](0107-capability-authz-framework.md) §4), so a fresh çaylak signup's
vote is refused with a typed `VoterNotEligible`. That is the anti-manipulation fix — a ring
of fresh sockpuppets can no longer inflate a score or farm karma.

This breaks the e2e spec `apps/web/tests/e2e/22-pano-live.spec.ts`. Its two-client
live-propagation flow has client A — a **fresh çaylak** created by the UI sign-up flow —
cast a pano post-vote, whose live `live.update` the second client asserts. Under the new
gate that vote is now rejected, so the assertion can never fire and the e2e gate goes red,
which blocks #1828 from landing.

The **root cause** is a capability gap, not a bad test: the e2e harness runs **HTTP-only
against the deployed per-PR preview worker** and has **no privileged handle to set account
state the public seam deliberately guards**. `user.tier` is server-managed and
`input:false` to better-auth (`apps/web/worker/db/drizzle/schema.ts`; the promotion path is
`Pasaport.promoteToYazar`, #1206) — there is no public mutation an e2e browser can drive to
promote a user. The **integration** harness does not have this gap: it holds privileged D1
access and #1828 adds a `Harness.promoteToYazar` there (a direct-D1 tier flip). The e2e
harness needs the same mechanism, which it currently lacks.

## Decision

Grant the e2e harness the **same privileged D1 REST path the integration harness uses**, and
add an e2e `promoteToYazar` helper that promotes a signed-up user to `yazar` via a direct D1
`UPDATE` off the worker binding. Concretely:

1. **Wire Cloudflare credentials into the `e2e` CI job.** The `e2e` job
   (`.github/workflows/ci.yml`) already injects nothing privileged into its Playwright step.
   Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (from the same `secrets.*` the
   `integration` job uses) plus `E2E_D1_DATABASE_ID` to the "Run e2e specs" step's `env`. The
   database id is **not** a new secret: it is the preview D1 uuid deploy.yml already surfaces
   in the sticky `<!-- d1:<uuid> -->` comment token, which the job resolves into
   `steps.preview.outputs.db` for the existing "Seed preview D1" step — the promote helper
   reads the **same** id, resolved the **same** way the preview URL is.

2. **Add an e2e `promoteToYazar(email)` helper** (`apps/web/tests/e2e/_helpers/promote.ts`)
   that runs an authenticated `POST /accounts/{accountId}/d1/database/{databaseId}/query` with
   `Bearer $CLOUDFLARE_API_TOKEN` to execute `UPDATE "user" SET tier = 'yazar' WHERE email = ?`
   against the preview stage's D1. It **mirrors the integration harness's setup-only D1 REST
   path exactly** — `cloudflareApi` + `runD1Query` in `apps/web/tests/integration/_harness.ts`
   (the same seam `setLastActivityAt`/`execD1` drive) — not a new mechanism. It is keyed by
   `email` because the UI sign-up flow does not surface the assigned user id; `email` is unique
   per better-auth signup and the only stable handle a spec holds, and the helper asserts
   exactly one row updated so a silent no-promote can't leave the gate red for the wrong reason.

3. **Promote client A before it votes** in `22-pano-live.spec.ts`: `signUpAndBootstrap` returns
   the sign-up email, and the two tests whose client A casts a pano post-vote call
   `promoteToYazar(emailA)` after sign-up. The vote is then cast by a `yazar`, the #1828 gate
   passes, and the live-propagation assertion runs.

This is **setup-only, off the worker binding** — the black-box HTTP contract still holds for
every assertion; the privileged D1 write is confined to test setup, exactly as the integration
harness confines its own D1 REST writes.

### Alternatives rejected

- **(B) A gated admin/promote route on the worker.** Rejected: it re-creates the deleted
  fail-open `/api/admin/*` seeder — an `ENVIRONMENT`-gated privileged route on the **public**
  worker, which was removed precisely because it is a security hole (a runtime path to
  privileged state reachable on the deployed worker; see `CLAUDE.md` "Sözlük seed"). Test setup
  must not reintroduce a runtime privilege-escalation surface; the privileged handle belongs
  **off the worker**, on the D1 REST API behind the CI-only Cloudflare token, reachable only by
  the test harness — never by the worker's request path.

- **(C) A test-only fate mutation to set tier.** Rejected: `user.tier` is `input:false` and
  server-promoted by design (ADR 0107 §4); a test-only mutation that writes it would either be
  a public surface (same hole as B) or an environment-forked worker code path that diverges
  test behavior from production — exactly the kind of drift the black-box harness contract
  (integration + e2e) exists to avoid. The direct-D1 REST write changes **no worker code** and
  keeps the deployed worker identical to production.

## Consequences

- The e2e job now carries the two Cloudflare secrets the integration job already carries. The
  existing author/fork gate on the `e2e` job (`changes.e2e_required`, which is false for an
  outside contributor's PR) already prevents the seed step's creds from running for a fork, so
  no new exposure is introduced — the promote step rides the same gate as the pre-existing
  seed step.
- The e2e harness gains **one** privileged capability — tier promotion — via the same D1 REST
  seam the integration harness uses. Future e2e flows that need privileged account state
  (further tier/karma setup) extend this helper module rather than adding a worker route.
- #1828 can land: its e2e coverage runs green because A votes as a yazar.

## References

- Issue [#1838](https://github.com/kamp-us/phoenix/issues/1838) (this decision), unblocking
  [#1828](https://github.com/kamp-us/phoenix/issues/1828) / [#1810](https://github.com/kamp-us/phoenix/issues/1810);
  parent investigation [#1705](https://github.com/kamp-us/phoenix/issues/1705).
- ADR [0082](0082-two-test-tiers-unit-integration.md) — the unit / integration test taxonomy and the
  black-box, real-remote-D1 harness contract this mirrors.
- ADR [0085](0085-auth-in-ci-storagestate-reuse.md) — the e2e projects (`setup`/`unauth`/
  `authed`/`flows`) the promoted flows run under.
- ADR [0107](0107-capability-authz-framework.md) §4 — the `visitor < çaylak < yazar`
  authorship ladder and the server-managed, `input:false` `user.tier` column this promotes.
- `CLAUDE.md` "Sözlük seed" — the deleted fail-open `/api/admin/*` seeder, the precedent that
  rejects alternative (B).
