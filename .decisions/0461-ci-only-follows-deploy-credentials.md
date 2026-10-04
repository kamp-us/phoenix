---
id: 0461
title: The integration tier's CI-only rule binds suites that need deploy credentials, never the tier name
status: accepted
date: 2026-10-04
tags: [testing, integration, ci, cloudflare, tuval]
---

# 0461 — The integration tier's CI-only rule binds suites that need deploy credentials, never the tier name

**What this decides:** `integration` stays one tier name across the repo. The rule that an
integration suite runs only in GitHub Actions applies to the suites that need a Cloudflare deploy
token. A suite named `integration` that needs no credentials runs anywhere, an agent's machine
included.

## Context

Two records define the `integration` tier, and both describe the Cloudflare worker case. ADR
[0082](0082-two-test-tiers-unit-integration.md) says `unit` is "no database, no SQL engine, no I/O"
and `integration` is real behavior against real remote Cloudflare D1. ADR
[0154](0154-integration-tier-is-ci-only.md) says "Integration tests run in GitHub Actions, period",
and gives one cause: the tier needs a Cloudflare deploy token, and no agent is issued one.

`apps/tuval` deploys nothing and has no D1. Its `integration` Vitest project runs a real Pi
`AgentSession` behind a real loopback socket and a real WebSocket codec
([`apps/tuval/vitest.config.ts`](../apps/tuval/vitest.config.ts)). That is I/O, so 0082's `unit`
excludes it, and it needs no credentials, so 0154's cause does not reach it. `packages/tuval-agy`,
`packages/tuval-claude`, `packages/tuval-codex` and `packages/tuval-pi` each carry an `integration`
project of the same kind.

An agent placing or running a test reads the tier name. Read by 0154's letter, the name bans local
runs of suites any agent could run for free. Read by what the Tuval suites are, it reopens the local
door 0154 shut for `apps/web`. [#7703](https://github.com/kamp-us/phoenix/issues/7703) asked which
reading holds and listed three options: re-scope the rule, split the name, or make the tier names
per-app vocabulary.

The ruling is on
[#7703, comment 5625056471](https://github.com/kamp-us/phoenix/issues/7703#issuecomment-5625056471):
keep one name and re-scope ADR 0154's CI-only rule to suites that need deploy credentials, then fix
the glossary and pattern rows. This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It amends 0082 and 0154 in part.

## Decision

**`integration` is one tier name, and ADR 0154's CI-only rule follows the deploy-credential
requirement, never the name.**

- **One name.** No third tier name is coined, and the tier names are not per-app vocabulary. `unit`
  and `integration` remain the repo's only two tiers.
- **What the name means for an app that is not a Cloudflare worker.** `integration` is the tier for
  a claim that needs a real engine or a real boundary, one a substituted seam cannot stand in for.
  For such an app that is real I/O at a real local boundary, with no deploy and no cloud credentials.
  For `apps/web` it stays what 0082 says: real remote Cloudflare D1 behind the deployed worker.
- **`apps/tuval`'s loopback-socket suite is `integration`.** So are the `integration` projects of
  `packages/tuval-agy`, `packages/tuval-claude`, `packages/tuval-codex` and `packages/tuval-pi`.
- **CI-only binds the credentialed suites.** A suite that needs a Cloudflare deploy token runs in
  GitHub Actions only, and no agent runs it locally. Today those are the `integration` projects of
  `apps/web` and `packages/preview-seed`. Everything 0154 says about them stands.
- **A credential-free `integration` suite runs anywhere.** An agent may run it locally, and CI may
  run it in a job that holds no Cloudflare token.
- **Which rule applies is read off the suite, not the name.** A suite that deploys to Cloudflare or
  reads a deploy token is credentialed. A suite that does neither is not.

**What stands unchanged.**

- 0082's two tier names, its ban on a faked SQL engine, and its definition of `apps/web`'s tier.
- 0154's second shut door: no local or unit-tier fake stands in for a real-Cloudflare path.
- 0154's rule that no agent is issued deploy credentials.

## Consequences

**An agent can run the Tuval suites before pushing.** It no longer reads 0154 as a ban on them.

**One name still covers two run policies.** A reader has to know which app or package a suite sits
in before knowing where it may run. The glossary and the testing pattern say so beside the tier
definition.

**A new credential-free suite needs no new record.** It takes the `integration` name and runs
anywhere. A new suite that needs deploy credentials is CI-only from its first commit.

**No suite moves.** This record changes what the name is read to mean. It changes no Vitest
project, script or CI job.

## Records

- Transcribes the ruling on
  [#7703, comment 5625056471](https://github.com/kamp-us/phoenix/issues/7703#issuecomment-5625056471),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- Vocabulary impact: redefines **test tiers (unit / integration)**. The row in
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) and the two-test-tiers entry in
  [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md#the-two-test-tiers-unit--integration-and-seam-graduation)
  carry it. The tier table in [`.patterns/effect-testing.md`](../.patterns/effect-testing.md) carries
  the run policy.
