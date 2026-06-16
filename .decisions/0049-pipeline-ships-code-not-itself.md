---
id: 0049
title: The pipeline ships code, not itself — product code (apps/web, packages) auto-merges via ship-it; skill/harness changes (.claude, .decisions, .patterns) merge manually
status: superseded by [0053](0053-control-plane-boundary.md)
date: 2026-06-13
tags: [pipeline, skills, ship-it, review-code, process]
---

# 0049 — The Pipeline Ships Code, Not Itself

> **Superseded by [0053](0053-control-plane-boundary.md).** The boundary is no longer "product code vs. harness" but the control plane: `.claude/**` + `.github/**` are blocking (manual merge); everything else — including `.decisions/**` and `.patterns/**` — is non-blocking and gated (`review-code` for code, `review-doc` for docs). 0053 also closes the gap this ADR left: `.github/**` was never in 0049's blocked set, so a workflow edit could auto-merge.

## Context

The issue-intake pipeline (`report` → `triage` → `plan-epic` → `write-code` →
`review-code` → `ship-it`; ADRs [0046](0046-plan-epic-prd-grade-plans.md),
[0047](0047-review-plan-gate.md), [0048](0048-ship-it-merge-actor.md)) was built to ship
product features and fixes from triaged GitHub issues autonomously, with `ship-it` as the
single auto-merge authority on a verified `review-code` PASS.

But the pipeline began modifying *itself* — the skills, ADRs, and patterns that define it
— which surfaced a circularity. Running `ship-it` on the PR that *adds* `ship-it`
([#179](https://github.com/kamp-us/phoenix/pull/179)) correctly **refused**, for two
reasons: (a) the skill PR never went through `review-code`, so no PASS verdict existed for
`ship-it` to consume; and (b) its linked issue ([#180](https://github.com/kamp-us/phoenix/issues/180))
was a `report`-issue with no `### Acceptance criteria`, so there was nothing for
`review-code` to gate against. Skill PRs do not fit the code pipeline's gate.

In practice the two reviewers had already diverged. Product code is gated by `review-code`
against an acceptance-criteria checklist; skill changes were reviewed by
`plugin-dev:skill-reviewer`, which caught a real merge-safety bug in `ship-it` and an
unanchored-query flaw that later manifested live. The verification lanes had split on their
own. The open question this ADR settles is the *merge* step for harness changes.

## Decision

1. **The issue-intake pipeline ships product code only.** Changes under `apps/web/**` and
   `packages/**` — the deployable worker and the shared packages — flow `write-code` →
   `review-code` → `ship-it`, and `ship-it` auto-merges on a verified `review-code` PASS.

2. **Skill / harness changes are out of pipeline scope.** Anything under `.claude/**`
   (skills, agents, hooks, settings), `.decisions/**` (ADRs), and `.patterns/**` (the docs
   defining how the pipeline and the code are shaped) is reviewed by the appropriate
   reviewer — `plugin-dev:skill-reviewer` for skills — and **merged manually by the
   maintainer**.

3. **The harness does not self-merge changes to itself.** Auto-merging an edit to the
   machine that performs the merge is a circuit-breaker waiting to fail; a human hand on the
   merge for self-modification is deliberate. `ship-it`'s existing guard 1 already enforces
   this for free — a skill PR never receives a `review-code` PASS, so `ship-it` refuses it,
   as it did on its own PR [#179](https://github.com/kamp-us/phoenix/pull/179). This ADR
   records the boundary that guard already produces; it adds no new `ship-it` logic.

4. **`review-code` stays code-focused.** It gates code PRs against an issue's
   acceptance-criteria checklist. It does **not** gate skill PRs, which close `report`-issues
   that carry no acceptance criteria. `skill-reviewer` is the reviewer for skill and harness
   changes.

## Consequences

- **Safer:** a buggy harness edit cannot auto-merge; self-modification always has a human
  checkpoint.
- **Clear lanes:** product code → `review-code` → `ship-it` (auto); skill / harness →
  `skill-reviewer` → manual merge.
- **Banned:** shipping a `.claude` / `.decisions` / `.patterns` change through `ship-it`;
  using `review-code` to gate a skill PR; an autonomous loop merging a change to its own
  skills.
- **Edge:** a PR mixing product code and harness changes should be split — the code half
  flows through the pipeline, the harness half is a manual merge.
- **Relationship:** scopes ADR [0048](0048-ship-it-merge-actor.md) (`ship-it` is the merge
  authority for *code*); complements [0047](0047-review-plan-gate.md) (review-plan gates
  plans) and [0046](0046-plan-epic-prd-grade-plans.md) (plan-epic). This ADR and its scope
  note are themselves a harness change, so per this very decision **this PR is merged by
  hand** — the first to ratify the rule.
