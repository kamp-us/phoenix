---
id: 0065
title: "Gate-critical skills (`ship-it`/`review-code`/`review-doc`/`review-plan`/`gh-issue-intake-formats.md`) are control-plane → BLOCKING (manual human merge); all other `skills/**` stay NON-blocking → auto-merge on a `review-code` PASS — narrows the all-skills-blocking stopgap to the 80/20: only the gate/merge machinery + marker contract need a human, because gate self-weakening is the one catastrophic case `review-code` can't catch; routing (review-code) unchanged for ALL skills (0063); amends 0063 (merge-authority corrected for the gate-critical subset only); extends 0053's boundary from \"by path\" toward \"by nature\"; stopgap-narrowed until the `review-skill` gate (#371)"
status: accepted
date: 2026-06-15
tags: [pipeline, ship-it, skills, control-plane, security]
---

# 0065 — Gate-critical skills are control-plane (blocking); other skills auto-merge

## Context

ADR [0053](0053-control-plane-boundary.md) made the agent control plane **blocking** — never
auto-merged, a human merges by hand — and drew that boundary by **PATH**: `.claude/**` +
`.github/**`. At the time the issue-intake skills lived under `.claude/skills/`, so they were
inside the blocking set automatically.

Issue #231 then moved the skills out of `.claude/skills/` to a root `skills/` directory. Because
0053's boundary is path-based, that move **silently dropped `skills/**` out of the blocking
set** — an unexamined side-effect of relocating the files, not a decision anyone took.

ADR [0063](0063-skills-are-code-gated.md) was written to fix a *different* problem — a deadlock
where a `skills/*.md`-only PR was classed docs and demanded a `review-doc` PASS that the
`review-code` gate (which actually runs on skills) never writes (#358). 0063 routed `skills/**`
→ `review-code` (good) and explicitly **did not revisit merge authority**. As a result, skills
became **auto-mergeable**: a `review-code` PASS now flowed a skill edit straight to `main` with
no human at the merge.

The first cut at this (a since-narrowed stopgap) made **all** `skills/**` blocking. But that
overshoots. `review-code` verifies a PR against its linked issue's acceptance criteria, not
gate-invariant preservation — and the one catastrophic case that property fails to catch is
narrow: **a gate auto-merging a weakening of *itself*.** If `ship-it` could auto-merge a PR that
removes its own control-plane refusal, or `review-code` could auto-merge a PR that softens its
own AC bar, the pipeline could quietly dismantle its own guardrails. Ordinary skill edits
(triage, plan-epic, write-code, heal-ci, report) do **not** have that property — they don't
merge or verify, so a bad edit there still has to pass through the gates that *do*. Blocking
those is needless friction.

## Decision

**Only the gate-critical skills are control-plane → BLOCKING (manual human merge).** ship-it
refuses to auto-merge any PR touching one of them, reporting `blocking — manual merge`, exactly
as it does for `.claude/**` and `.github/**`. Every **other** `skills/**` path stays
**NON-blocking** — auto-merged on a `review-code` PASS, unchanged from ADR 0063 / #364.

The gate-critical set is the verification/merge machinery itself plus the marker contract every
gate depends on:

- `skills/ship-it/**` — the merge actor.
- `skills/review-code/**` — the code gate.
- `skills/review-doc/**` — the doc gate.
- `skills/review-plan/**` — the plan gate.
- `skills/gh-issue-intake-formats.md` — the shared marker-namespace / regex contract every gate
  resolves verdicts against.

These are **two independent axes — do not conflate them**:

- **Routing (which gate verifies):** **ALL** `skills/**` → `review-code`. **UNCHANGED** for every
  skill — ADR 0063 stands. The human reads the `review-code` verdict on a gate-critical PR.
- **Merge authority (who merges):** **gate-critical skills** → **BLOCKING** (manual human merge);
  **all other `skills/**`** → auto-merge on a `review-code` PASS.

So a gate-critical skills PR is still verified by `review-code` (its PASS is the verdict a human
reads), but ship-it REFUSES to auto-merge it — a human merges by hand. In ship-it's Step 0 the
blocking refusal short-circuits *before* the namespace check, so the `review-code` routing is
never exercised for the merge decision and the two axes never collide.

This is the **80/20**: ~5 files need a human at the merge; the rest of `skills/**` stay
hands-off. It is **safe-by-default for the only catastrophic case** (gate self-weakening) until
the proper fix lands — a dedicated **`review-skill`** gate (issue #371) that verifies behavioral
correctness and gate-invariant preservation per artifact. Once `review-skill` lands, even the
gate-critical set can be revisited (e.g. auto-merge on a trusted `review-skill` PASS).

## Consequences

- **No deadlock.** The gate-critical few are human-merged, and `review-code` still posts its
  verdict on them — the human reads it, then merges. The #358 routing fix is preserved verbatim:
  ship-it refuses with `blocking — manual merge` in Step 0 *before* the namespace check runs, so
  there is no `review-doc`-vs-`review-code` mismatch to hit.
- **Ordinary skill work stays autonomous.** triage / plan-epic / write-code / heal-ci / report
  and the rest of `skills/**` auto-merge on a `review-code` PASS, exactly as under 0063 / #364 —
  they are deliberately **NOT** in the gate-critical set because they neither merge nor verify, so
  a bad edit to one still has to clear the gates that do.
- **Relationship:** this ADR **amends** ADR [0063](0063-skills-are-code-gated.md) — it keeps
  0063's `review-code` routing unchanged for *all* skills and corrects the merge-authority
  side-effect only for the gate-critical subset. It does **not** supersede 0063. It extends ADR
  [0053](0053-control-plane-boundary.md)'s control-plane boundary from "by path" toward "by
  nature": the executable gate logic is control plane *wherever it lives*, so a future relocation
  cannot silently drop the property again. The path probe is still the mechanism; the principle it
  encodes is now stated.
- **This PR is non-control-plane under current rules.** It touches only `skills/**` (a gate-
  critical one: `skills/ship-it/`) + `.decisions/**` (not `.claude/**`/`.github/**`), so under the
  *current* rules it is `review-code`-gated. Once this rule takes effect it would itself be
  blocking — it edits `skills/ship-it/` — so it is among the last gate-critical PRs that could
  auto-merge before the property it adds is live.
- **Enforced at the platform by [0071](0071-enforce-control-plane-at-github.md).** This ADR's
  gate-critical set (`skills/ship-it`/`review-code`/`review-doc`/`review-plan` +
  `gh-issue-intake-formats.md`) is, like 0053's `.claude`/`.github`, honor-system at the GitHub
  level (#382). 0071 adds those exact paths to a human-only `CODEOWNERS` and turns on
  `require_code_owner_review`, so a control-plane merge of a gate-critical skill needs a human
  approval that — per 0071's resolution of the ADR-0055 wrinkle — an agent's ACL-sourced
  approval cannot satisfy.
