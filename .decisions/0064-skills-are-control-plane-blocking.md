---
id: 0064
title: "`skills/**` is control-plane — BLOCKING (manual merge), a stopgap until `review-skill`"
status: accepted
date: 2026-06-15
tags: [pipeline, ship-it, skills, control-plane, security]
---

# 0064 — `skills/**` is control-plane — BLOCKING (manual merge), a stopgap until `review-skill`

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
→ `review-code` and explicitly **did not revisit merge authority**. As a result, skills became
**auto-mergeable** as a second unexamined side-effect: a `review-code` PASS now flowed a skill
edit straight to `main` with no human at the merge.

But a skill is **agent behavior** — the executable contract an agent runs. Editing one is
self-modification of the harness, the exact risk 0053's blocking property guards against, and it
does not stop being that risk because the files moved directory. `review-code` is the wrong
rigor to be the *only* thing between a skill edit and `main`: it verifies a PR against its
linked issue's acceptance criteria, not the behavioral correctness or gate-invariant
preservation a control-plane change demands.

## Decision

**`skills/**` is control-plane → BLOCKING (manual human merge).** ship-it refuses to
auto-merge any PR touching `skills/**`, reporting `blocking — manual merge`, exactly as it does
for `.claude/**` and `.github/**`. This restores the property #231 silently dropped.

These are **two independent axes — do not conflate them**:

- **Routing (which gate verifies):** `skills/**` → `review-code`. **UNCHANGED** — ADR 0063
  stands. The human reads the `review-code` verdict.
- **Merge authority (who merges):** `skills/**` → **BLOCKING** — manual human merge. Added
  here.

So a skills PR is still verified by `review-code` (its PASS is the verdict a human reads), but
ship-it REFUSES to auto-merge it — a human merges by hand. In ship-it's Step 0 the blocking
refusal short-circuits *before* the namespace check, so the `review-code` routing is never
exercised for the merge decision and the two axes never collide.

This is a **safe-by-default STOPGAP.** The proper fix is a dedicated **`review-skill`** gate
(issue #371) — a per-artifact gate that verifies behavioral correctness and gate-invariant
preservation. Once `review-skill` lands, blocking-vs-auto can be revisited: e.g. gate-critical
skills stay blocking, while ordinary skills auto-merge on a trusted `review-skill` PASS. Until
then, blocking-by-default is the conservative choice — a human in the loop is cheap insurance
against the harness editing its own guardrails.

## Consequences

- **Humans merge skill PRs again** — the pre-#231 behavior is restored. The control-plane
  property is now upheld by ship-it's blocking refusal, not by which directory the skill
  happens to live in.
- **The #358 deadlock stays resolved.** ship-it refuses with `blocking — manual merge` in Step
  0 *before* the namespace check runs, so there is no `review-doc`-vs-`review-code` namespace
  mismatch to hit — the refusal short-circuits the path that produced the deadlock. ADR 0063's
  routing fix is preserved verbatim.
- **The boundary generalizes from "by path" toward "by nature."** 0053 drew the line at
  specific paths; this ADR recognizes that a skill is agent control plane *wherever it lives*,
  so a future relocation cannot silently drop the property again. The path probe is still the
  mechanism, but the principle it encodes is now stated.
- **Relationship:** this ADR **amends** ADR [0063](0063-skills-are-code-gated.md) — it keeps
  0063's `review-code` routing unchanged and corrects only the merge-authority side-effect 0063
  left open. It does **not** supersede 0063. It extends ADR
  [0053](0053-control-plane-boundary.md)'s control-plane boundary to cover `skills/**`.
- **This PR is the irony.** Because it touches only `skills/**` + `.decisions/**` (not
  `.claude/**`/`.github/**`), under the *current* rules it is itself `review-code`-gated and
  auto-mergeable — it is the last skills PR that could auto-merge, before the rule it adds takes
  effect.
