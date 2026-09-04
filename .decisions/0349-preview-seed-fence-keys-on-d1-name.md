---
id: 0349
title: preview-seed's throwaway fence keys on the D1 database name, not on human-row count
status: accepted
date: 2026-09-03
tags: [preview-seed, review-ui, security, ci, d1]
---

# 0349 — preview-seed's throwaway fence keys on the D1 database name, not on human-row count

**What this decides:** `preview-seed test-account` refuses a target whose Cloudflare-recorded D1
name does not carry the per-PR preview segment `-pr-`. It no longer counts human `user` rows.

## Context

The fence exists so nobody can mint a moderator identity plus a live session token in a real
database. Its first form was emptiness: refuse any target holding a human `user` row that is none
of the test identities. The reasoning was that a preview D1 deploys empty, so rows are evidence of
somebody's real world.

CI falsified that premise. The Playwright e2e job runs against the same per-PR preview D1 the
capture route seeds — `.github/workflows/ci.yml` hands it `E2E_D1_DATABASE_ID:
${{ steps.preview.outputs.db }}` — and 30 specs sign real users up through
`/api/auth/sign-up/email` via `apps/web/tests/e2e/_helpers/auth.ts`. Nothing in `.github/` ever
invoked `test-account`, so provisioning only ever happened after those sign-ups. Every preview
whose e2e job had run refused forever, which is most of them, and `review-ui render --surface
<route>:auth` / `:auth-caylak` — the whole point of #7398 — had nowhere left to run. #7708 and
#7045 both parked on this wall, and every ticket under epic #4304 met it (issue
[#7740](https://github.com/kamp-us/phoenix/issues/7740)).

Four shapes were on the table: re-key the fence on the name, seed the identities in CI before e2e,
give the capture its own D1, or have e2e tag its sign-ups.

## Decision

Key it on the name. Founder ruling, 2026-09-04:
[#7740 comment](https://github.com/kamp-us/phoenix/issues/7740#issuecomment-5535874078) — a database
whose name contains `-pr-` (the per-PR preview shape `phoenix-phoenix-db-pr-<n>-…`) is throwaway;
anything else, including `…-prod-…` and any renamed stage, refuses, fail closed.

The name is resolved from Cloudflare's own record for the given `--database-id`
(`GET /accounts/{account_id}/d1/database/{id}`, through `@kampus/d1-rest`'s `resolveDatabaseName`),
never composed by the caller. A record that comes back with no name is UNKNOWN and refuses too.

## Why this is not a relaxation the README argued against

`packages/preview-seed/README.md` carried a standing argument that there must be no override flag,
because an override puts the decision back in the caller's hands. That argument survives intact and
is the reason this shape was picked over "tag the e2e sign-ups" or a `--yes-really` flag: the deploy
stack writes the database's name and the caller cannot, so there is still nothing here a caller can
assert their way past. What changes is which fact about the target the fence reads, not who gets to
decide.

The reach is narrower in one direction and wider in another, and both are stated in the README:
production and every named stage are caught, because none of them carries `-pr-`; a database
somebody deliberately named to look like a per-PR preview is not caught, exactly as the old check
did not catch an empty non-throwaway. The operator still owns which `--database-id` they pass.

## Consequences

- A preview full of e2e sign-ups provisions cleanly, which is the normal case the old fence
  refused.
- The refusal now names the database's name rather than a row count, so an operator reads why
  directly.
- `countForeignAccounts` is gone from `@kampus/preview-seed`; the fence is
  `isThrowawayDatabaseName`, a pure predicate, decided before any token is read.
- `test-account` needs D1 *read* on the account token as well as write, for the name lookup.
- Seeding the identities in CI ahead of e2e (shape 2) is no longer needed for this wall, and is not
  taken here.
