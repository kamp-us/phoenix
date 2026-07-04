---
id: 0150
title: The control-plane / §CP boundary covers the pipeline agent definitions (`claude-plugins/kampus-pipeline/agents/**`) — a gate/merge agent's own instructions are a self-weakening surface, so they are BLOCKING (human merge) and review-skill-routed for the verdict
status: accepted
date: 2026-07-04
tags: [control-plane, pipeline, security, ship-it]
---

# 0150 — The control-plane boundary covers the pipeline agent definitions

## Context

ADR [0053](0053-control-plane-boundary.md) drew the control-plane / blocking boundary by
**path**; ADR [0065](0065-gate-critical-skills-are-blocking.md) sharpened it toward "by
nature" — the gate/merge machinery is control plane *wherever it lives*, because the one
catastrophic case a quality gate can't catch is **a gate auto-merging a weakening of
itself**; ADR [0100](0100-control-plane-covers-enforcement-guard-packages.md) reached the
enforcement-guard packages on the same reasoning. But one surface unambiguously inside that
principle was still missed: the **pipeline agent definitions** under
`claude-plugins/kampus-pipeline/agents/**`.

These files are the behavior instructions for the very agents that run the pipeline —
`shipper.md` (the merge authority), `reviewer.md` (the verdict gate), plus `coder.md`,
`planner.md`, `reporter.md`, `triager.md`. They are a *sibling* of `skills/`, not under it,
so an agents-only PR (every changed path under `agents/`) matched **none** of `ship-it`
Step 0's classifiers:

- `CONTROL_PLANE_RE` (blocking probe) had no `agents/` clause → **not blocking**.
- the has-skills probe `^claude-plugins/kampus-pipeline/skills/` — `agents/` is a sibling,
  not under `skills/` → **no match**.
- the has-code probe `^(apps|packages|\.glossary|infra)/` → **no match**.
- the has-docs probe strips every `^claude-plugins/` path *before* the `.md$` test →
  **no match**.

Net: an agents-only PR was classified **non-blocking** *and* belonged to **no gate class**,
so `ship-it` would enqueue / auto-merge it with **no human merge and no routed review gate**.
A PR editing only `shipper.md` or `reviewer.md` could therefore auto-ship a weakening of the
merge authority or the verdict gate with zero human eye — exactly the
self-modification-of-guardrails risk §CP exists to prevent (the same ADR 0065 rationale that
makes gate-critical skills blocking; the ADR 0143 lineage of auto-shipping the control
plane). Verified live: PR #2001 edited all six agent defs and matched none of the four
classifiers. Filed as issue [#2003](https://github.com/kamp-us/phoenix/issues/2003), typed a
coverage **bug**, not a policy fork — there is no honest argument that the merge-authority /
verdict-gate agents' own instructions fall outside the self-weakening surface; the boundary
was drawn (0065) and simply missed a path that plainly belongs.

Supersedes nothing; extends [0053](0053-control-plane-boundary.md) (the path boundary),
[0065](0065-gate-critical-skills-are-blocking.md) (gate-critical surfaces are blocking by
nature, regardless of directory), and the two-axis merge-authority-vs-routing split ADR
[0073](0073-review-skill-gate.md) established.

## Decision

The §CP control-plane / blocking set is extended to cover the **pipeline agent
definitions** — `claude-plugins/kampus-pipeline/agents/**` — alongside `.claude/**`,
`.github/**`, the gate-critical skills, the plugin hook surface, and the enforcement-guard
packages.

The single canonical `CONTROL_PLANE_RE` in §CP of
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` gains one clause:

```
…|^claude-plugins/kampus-pipeline/agents/|…
```

The clause is mirrored byte-identically into the four consumer copies the
`validate-gate-path-drift.sh` guard enforces (`ship-it`, `review-code`, `review-doc`,
`review-skill`); `review-plan` / `review-trivial` read the canonical live from `origin/main`
and track it automatically.

The two axes stay consistent with how the gate-critical skills are handled (the ADR 0065 /
0073 split):

- **Merge authority → blocking.** An agents-only PR is §CP → `ship-it` does not auto-merge;
  it is human-merged behind the `@kamp-us/control-plane` approval gate (ADR
  [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). `.github/CODEOWNERS`
  gains a `/claude-plugins/kampus-pipeline/agents/ @kamp-us/control-plane` row so
  `require_code_owner_review` covers the surface.
- **Verdict routing → `review-skill`.** Agent defs are behavioral artifacts like skills, so
  they route to `review-skill` for the verdict — consistent with the has-skills routing
  rationale (ADR 0073). `ship-it`'s has-skills probe, `review-code`'s skills-only off-ramp,
  and `review-skill`'s own in-scope test all widen from
  `^claude-plugins/kampus-pipeline/skills/` to `^claude-plugins/kampus-pipeline/(skills|agents)/`,
  so an agents-only PR routes to exactly one real gate rather than none.

The merge-authority axis and the verdict-routing axis remain independent, exactly as for the
gate-critical skills: routing decides *which gate's verdict the human reads*; the §CP set
decides *whether the enqueue is human-gated*.

## Consequences

- Agents-only PRs are now **human-merged** (§CP approval gate) and **`review-skill`-gated** —
  the classification gap that let PR #2001's file set slip through both is closed. Re-running
  an agents-only file set against the patched `CONTROL_PLANE_RE` now yields `BLOCKING` +
  the `has-skills` class.
- The `agents/` clause sits inside the §CP set, so a PR editing `CONTROL_PLANE_RE` (this
  change) is itself §CP and is human-merged — correct self-referential behavior, the same as
  every prior §CP-set edit (0065/0100/0103).
- The has-code / has-docs probe agreement invariant is untouched: `agents/` is under
  `claude-plugins/`, which the has-docs `-Ev` already excludes, so no agents `.md` ever falls
  to the doc class; the change adds a class, it does not perturb the code/docs carve-out.
- The `.claude/skills` symlink and marketplace-source agreement are unaffected; the drift
  guard passes on all four regex copies plus the symlink invariant.
