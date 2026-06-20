---
id: 0100
title: The control-plane / §CP boundary covers the enforcement-guard packages (`packages/*-guard/**` + `packages/ci-required/**`) — a guard is a self-weakening surface wherever it lives, so it is BLOCKING (human merge), not auto-merged on a `review-code` PASS
status: accepted
date: 2026-06-20
tags: [pipeline, ship-it, control-plane, security, guards]
---

# 0100 — The control-plane boundary covers the enforcement-guard packages

## Context

ADR [0053](0053-control-plane-boundary.md) drew the control-plane / blocking boundary by
**path** — `.claude/**` + `.github/**` — and put **all** of `packages/**` on the
autonomous, `review-code`-gated lane. ADR [0065](0065-gate-critical-skills-are-blocking.md)
then sharpened the principle from "by path" toward "by nature": the gate/merge machinery is
control-plane *wherever it lives*, because the one catastrophic case a quality gate can't
catch is **a gate auto-merging a weakening of itself**. It added the gate-critical *skills*
to the blocking set on exactly that reasoning.

But the same reasoning reaches further than 0065 went. The repo's **enforcement-guard
packages** are executable guardrails, not product code:

- `packages/spawn-guard/**` — the PreToolUse hook enforcing the ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md) fail-closed spawn policy.
- `packages/read-guard/**`, `packages/worktree-guard/**`,
  `packages/structured-output-guard/**` — gate agent tooling.
- `packages/leak-guard/**` — blocks secret leaks.
- `packages/ci-required/**` — aggregates the gating CI checks.

Each is a self-weakening surface in the precise sense 0065 names: a bad (or adversarial)
edit that flips one of these fail-open is the "a guard auto-merges a weakening of itself"
case the control-plane boundary exists to prevent. Yet §CP missed them because they are
`packages/`, not `.claude`/`.github`/skills — so by the letter of the rule a guard-package
diff was non-blocking and an autonomous `ship-it` (on a `review-code` PASS) would merge it.
This surfaced live: PR #900 (issue #858) touched only `packages/spawn-guard/**`, earned a
binding `review-code: PASS`, and only a **human-deferral judgment** — not the rule — held it
back from auto-merge. As autonomous drain volume grows, that gap merges a guard regression
with no human.

Supersedes nothing; extends [0053](0053-control-plane-boundary.md) (the path boundary) and
[0065](0065-gate-critical-skills-are-blocking.md) (gate-critical surfaces are blocking by
nature, regardless of directory). The guard packages are the `packages/` instance of 0065's
"by nature" principle — a guardrail is control plane wherever it lives.

## Decision

The §CP control-plane / blocking set is extended to cover the **enforcement-guard
packages**, alongside `.claude/**`, `.github/**`, and the gate-critical skills:

- `packages/<name>-guard/**` — matched by the `^packages/[^/]*-guard/` clause (covers
  `spawn-guard`, `read-guard`, `worktree-guard`, `structured-output-guard`, `leak-guard`,
  and any future `*-guard` package added under `packages/`).
- `packages/ci-required/**` — the gating-check aggregator, matched by `^packages/ci-required/`.

The single canonical `CONTROL_PLANE_RE` in §CP of
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` gains the two clauses:

```
…|^packages/[^/]*-guard/|^packages/ci-required/
```

A PR touching any of these paths is **control plane**: `ship-it` refuses to auto-merge it
(its Step 0 control-plane refusal short-circuits before any gate-verdict / namespace check)
and a human merges it by hand. The `review-code` routing for guard packages is unchanged —
they are still verified by `review-code` (its PASS is the verdict a human reads); only the
*merge authority* moves to human, exactly the two-axis split ADR 0065 established for the
gate-critical skills.

The boundary stays anchored and narrow: only `packages/` directories whose name ends in
`-guard`, plus `packages/ci-required`, are control plane. Every other package
(`fate-effect`, `db-schema`, `gh-phoenix`, `epic-ledger`, …) remains non-blocking and
auto-merges on a `review-code` PASS.

## Consequences

- **The guard packages can no longer auto-merge a self-weakening.** A `packages/spawn-guard/`
  -only diff is now classed control-plane → `ship-it` refuses → human merge. PR #900 is
  confirmed human-merge under the rule, not just under reviewer judgment.
- **No over-match.** The `^packages/[^/]*-guard/` clause is anchored to a trailing `-guard`
  package name; a non-guard package (`packages/fate-effect/`, etc.) is untouched and still
  rides the autonomous lane.
- **All `CONTROL_PLANE_RE` copies stay in sync.** The two clauses were added byte-identically
  to the four consumer copies (`ship-it`, `review-code`, `review-doc`, `review-skill`) and
  the §CP canonical; `validate-gate-path-drift.sh` extracts the canonical and diffs the copies,
  so the existing CI drift guard enforces the new regex with no script change.
- **Banned:** auto-merging any PR touching `packages/*-guard/**` or `packages/ci-required/**`
  (refuse → human merge); a §CP copy that carries the guard clause in some surfaces but not
  others (drift-guard reddens it).
- **Platform enforcement is a follow-up.** ADR [0071](0071-enforce-control-plane-at-github.md)
  binds the §CP set at the GitHub level via `CODEOWNERS` + `require_code_owner_review`. The
  guard-package paths are not yet in `.github/CODEOWNERS`, so this ADR's boundary is
  `ship-it`-honor-system for the guard packages until CODEOWNERS is extended — the same
  honor-system → platform-enforced progression 0071 closed for the original §CP set.
