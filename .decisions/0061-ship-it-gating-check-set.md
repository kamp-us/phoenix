---
id: 0061
title: ship-it gates on the gating-check set, not the full rollup; preview deploys are informational (denylist of known-informational checks, fail-safe to blocking; consistent-by-construction with the run-evidence bundle)
status: accepted
date: 2026-06-15
tags: [pipeline, skills, ship-it, heal-ci, ci, agents]
---

# 0061 — ship-it Gates on the Gating-Check Set, Not the Full Rollup; Preview Deploys Are Informational

## Context

`ship-it` Step 3 ("Confirm CI is green") read the whole `gh pr checks` rollup and refused
to merge — routing to `heal-ci` — on **any** red check, with no required/optional
dimension. The skill's prose said "which checks are *required* follows the repo's CI
config," but the logic counted every `bucket=fail` as blocking. The two disagreed.

The gap first bit on PR #307 — the first `ship-it` CI evaluation on a non-control-plane PR
(all prior auto-merges were control-plane → manual, which bypass Step 3). Every gating
check was green (lint/typecheck, unit, integration, run-evidence), both gates posted
SHA-bound PASS, and a single `deploy (web)` check was red: a Cloudflare preview-deploy infra
flake (`AuthError: Edge-preview secret read failed: Secret probe returned 502`), unrelated
to a PR that adds no worker or deploy code. `main` has **no required-status-check branch
protection**, so that red `deploy (web)` does not block a GitHub merge — yet Step 3 refused
anyway and routed a non-failure to `heal-ci`, stalling a genuinely-mergeable PR.

Three candidate definitions of "gating" were on the table: (1) read GitHub's
required-status-checks ruleset; (2) an explicit allow/deny list in the skill; (3) the four
known CI jobs hard-coded. Definition (1) is the principled one — "gating" = what GitHub
itself blocks on — but `main` declares no required-status-checks, so under (1) *nothing*
is gating and `ship-it` would merge even with red **unit tests**. That is unsafe: it
decouples the merge gate from the test suite the moment branch protection is absent, which
is exactly the repo's current state.

## Decision

`ship-it` Step 3 classifies checks by **name** and gates on the **gating set**, defined as a
**denylist of known-informational checks, fail-safe to blocking**:

- A red check **blocks** (refuse + route to `heal-ci`) **by default**.
- A red check is **non-blocking** only when its name is on the explicit **known-informational
  list** — the `Deploy` workflow's preview-deploy-infra checks: `deploy (web)` (the `pr-<n>`
  preview-stage deploy) and `cleanup (web, …)` (the `Deploy` workflow's preview-stage
  `alchemy destroy` teardown leg). Both are orthogonal to whether the PR is correct
  and tested — a teardown race (e.g. a close→reopen on PR #914) reds `cleanup` without
  bearing on the run-evidence suite.
- An **unrecognized** red check is treated as **gating** (it blocks) until it is deliberately
  added to the informational list. The default is fail-safe: a new check never silently
  passes the gate.

The gating set is, by construction, the suite the **run-evidence bundle** attests SHA-bound
in Step 3.5 (lint / format / typecheck, unit tests, validate skill frontmatter, integration
when it runs). Step 3 is the cheap early read; Step 3.5 is the SHA-bound authority. They
cannot contradict, because the run-evidence suite is never on the informational denylist —
if the two ever disagree, **Step 3.5 wins** (ADR 0054).

`pending` still stops with `checks pending — not yet merge-ready`; `skipping`/`cancel` stay
non-blocking. The `heal-ci` lane is now fed only *gating* reds, never preview-deploy flakes.

## Why not GitHub required-status-checks as the source of truth

Definition (1) is correct *when branch protection declares required checks* — and the design
above degrades to it cleanly: if a required-checks ruleset is ever added, those checks are
all gating (none would be on the informational denylist), so `ship-it` stays consistent with
GitHub. But with no ruleset today, (1) alone would gate on nothing and merge red test
suites. The denylist makes the safe behavior the *default* and treats GitHub protection as
an additive constraint, not the sole authority.

## Consequences

- A non-gating red (preview-deploy flake) no longer stalls a verified, tested, green-suite
  PR, and no longer pollutes the `heal-ci` lane with non-failures.
- A red gating check still refuses and routes to `heal-ci` exactly as before — no regression
  on the real-failure path — and any *new* unrecognized check fail-safes to blocking.
- The known-informational list is a small, explicit surface in
  `.claude/skills/ship-it/SKILL.md` Step 3. Adding a deploy-class check there is a
  deliberate, reviewable act; the list must never contain a CI-suite / run-evidence check.
