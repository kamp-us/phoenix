---
id: 0085
title: Authenticated e2e in CI uses Playwright `storageState` reuse — one real sign-up, amortized
status: accepted
date: 2026-06-18
tags: [testing, e2e, ci, auth, playwright]
---

# 0085 — Authenticated e2e in CI uses Playwright `storageState` reuse — one real sign-up, amortized

## Context

The e2e suite has authenticated specs — search create-then-search
([#548](https://github.com/kamp-us/phoenix/issues/548),
`apps/web/tests/e2e/24-search.spec.ts`), and every pano/sözlük write flow, the
auth-redirect specs, etc. — that need a logged-in session against the per-PR
preview worker. Today each such spec drives Better Auth's real sign-up form via
`apps/web/tests/e2e/_helpers/auth.ts` (`signUp`) against the live worker.

The e2e-in-CI gate ([#567](https://github.com/kamp-us/phoenix/issues/567))
currently runs **only the unauth specs**, precisely because *how* an authed
session is established in CI was left undecided — carved out as this decision
child rather than handwaved. The surrounding pieces have since landed, so this
auth strategy is the remaining blocker to running authed specs in CI:

- Search ships (m3), so the authed search spec has something real to assert.
- `@kampus/preview-seed` can seed a real preview D1
  ([#569](https://github.com/kamp-us/phoenix/issues/569) /
  [#573](https://github.com/kamp-us/phoenix/issues/573) merged) — preconditions
  for authed flows can be set up against the same remote D1 the worker reads.
- The two-tier test rewrite landed (ADR
  [0082](0082-two-test-tiers-unit-integration.md),
  [#563](https://github.com/kamp-us/phoenix/issues/563)): `integration` runs
  against real remote D1, e2e drives the real preview worker — there is no faked
  engine anywhere, so the e2e session must be a real one too.

The fork this ADR settles: how do authed specs get a session **fast enough** to
run the whole suite in CI without (a) re-signing-up per test, or (b) introducing
a standing test-only auth surface that weakens production auth. The deleted
fail-open seeder routes are the cautionary precedent (CLAUDE.md "Sözlük seed":
the `ENVIRONMENT`-gated `/api/admin/*` seeders were removed *because* a fail-open
auth hole is unacceptable) — whatever we pick must not reopen that class.

## Decision

**Authenticated e2e specs in CI reuse a Playwright `storageState` captured from
one real sign-up.**

1. **One real sign-up in global setup.** A Playwright `globalSetup` (equivalently
   a project `setup` dependency that produces the artifact) performs **one** real
   Better Auth sign-up — the exact flow `_helpers/auth.ts` `signUp` already drives
   (visit `/auth`, flip to sign-up, fill name/email/password, submit, wait for the
   redirect off `/auth`), plus the username-bootstrap gate (`completeBootstrap`) —
   against that CI run's per-PR preview worker. It is a **real** sign-up: full
   Better Auth flow, real session minted, real remote D1 write. Nothing about the
   worker's auth path is special-cased.

2. **Capture the authed cookies into a `storageState` file.** After sign-up the
   setup saves `page.context().storageState({ path })` — the authed session
   cookies — to a `storageState` file produced fresh for this run (not committed,
   not checked in).

3. **Authed specs consume the storageState; unauth specs do not.** Authed specs
   run in a Playwright project whose `use.storageState` points at that file (and
   that `dependsOn` the setup project), so every authed spec starts already
   logged in — no per-test sign-up. The unauth specs keep running in a project
   with **no** storageState, exactly as the gate runs them today
   ([#567](https://github.com/kamp-us/phoenix/issues/567)), so the unauth lane is
   unchanged.

It is a **real sign-up, just amortized** across the suite: N authed specs share
one minted session instead of minting N.

### Why this over the alternatives

| Option | Verdict | Why |
|---|---|---|
| **(a) real sign-up per test** (status quo `signUp`) | rejected | Honest — it is the real auth path — but N sign-ups blow up suite wall-clock (each is a full form + redirect + bootstrap round-trip against the remote worker). storageState keeps the same realism at 1× cost. |
| **(b) seeded test user + programmatic API login** | rejected | Fast, but it stands up a **known-credential account in every preview** — a permanent, gated auth surface that exists only for tests. That is a new standing credential to protect and a fail-open risk if the preview ever leaks to a non-preview origin. Avoiding a new standing auth surface is the whole point of the seeder-deletion lesson. |
| **(c) storageState reuse** | **chosen** | One **real** sign-up, amortized; **no new standing credential** (the session is ephemeral, born and discarded per run); **no test-only auth bypass** (the worker never learns it is under test). |

## Security note (load-bearing)

**This introduces no fail-open test-auth bypass.** phoenix deleted its
`ENVIRONMENT`-gated seeder routes precisely because a fail-open auth hole is
unacceptable (CLAUDE.md "Sözlük seed"). `storageState` is categorically different
from that hazard:

- It is a **real sign-up captured**, not a bypass header/cookie the worker
  special-cases. The session in the file is one a real user could have minted by
  filling the form.
- The **preview worker's auth path is unchanged** — no test-only branch, no
  `ENVIRONMENT`-gated shortcut, no credential the worker trusts because "it's a
  test." There is nothing in the worker to fail open.
- The trust boundary lives entirely **in the test harness** (Playwright reusing a
  cookie it legitimately obtained), never in the deployed surface. Production auth
  — and the preview's auth, which *is* production auth running at
  `ENVIRONMENT=development` — is identical with or without this decision.

## Consequences

- **Freshness / isolation: captured per CI run, against that run's preview.** The
  `storageState` is created fresh in each run's global setup, against that run's
  per-PR preview worker, and is **not committed and not reused across runs**. This
  sidesteps session-expiry/staleness entirely — a session is at most one suite old
  — and keeps runs isolated (no shared standing account two PRs could race on).
- **Wiring is the next step, not this ADR.** Non-binding pointers for the
  implementing child (#567 wiring + #548's spec):
  - Add the `setup` project (or `globalSetup`) to `apps/web/playwright.config.cjs`
    that calls the existing `signUp` + `completeBootstrap` against `E2E_BASE_URL`
    and writes the storageState file.
  - Split the projects: an authed project (`use.storageState`, `dependsOn` setup)
    and the existing unauth project (no storageState).
  - Point #567's gate at the full suite once the authed project is green; until
    then it stays unauth-only.
  - Specs that need a *specific* user/handle (rather than "any logged-in user")
    still drive their own sign-up — the shared storageState is the "any authed
    user" default, not a mandate.
- **A spec that mutates the shared user's state can bleed into another authed
  spec** (one session, one account). The single-worker, non-parallel Playwright
  config (`workers: 1`, `fullyParallel: false`) bounds this today; specs needing a
  pristine user opt out by signing up their own.
- **Relates to:** ADR [0082](0082-two-test-tiers-unit-integration.md) (e2e drives
  the real preview worker, no faked engine — so the session is real too),
  [0083](0083-agents-deploy-humans-release.md) (preview deploys are the CI target
  the suite runs against). Implementation of the chosen mechanism is out of scope
  here (the #567/#548 wiring), as is any non-auth e2e flow.
