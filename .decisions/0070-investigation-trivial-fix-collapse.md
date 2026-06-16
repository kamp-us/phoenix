---
id: 0070
title: "An investigation that resolves into a trivial fix collapses into one PR (write-code), bounded"
status: accepted
date: 2026-06-15
tags: [pipeline, write-code, triage, investigation, intake-contract]
---

# 0070 — An investigation that resolves into a trivial fix collapses into one PR (write-code), bounded

## Context

The issue-intake suite (`report → triage → plan-epic → review-plan → write-code →
review-code/review-doc → ship-it`) routes each issue by type. write-code's
`type:investigation` routing (`skills/write-code/SKILL.md` → Type routing →
`type:investigation`) says the deliverable is a **diagnosis**: post the closing comment,
close `completed`, and file any actionable residue as **fresh `report` issues** that
re-enter at `status:needs-triage`. The skill is explicit that investigations "don't merge
a PR to close."

That contract has no path for the common terminal case: **an investigation whose answer
*is* a known, trivial, unambiguous fix.** Under the letter of the rule, a one-line fix
that the investigation already proved out must be re-filed as a `report`, walk
`triage → write-code` again, and only then become code — three pipeline hops and three
issues for one line. So agents do one of two bad things:

- **Follow the letter** — route the trivial fix through `report → triage → write-code`,
  paying ceremony and latency the change does not warrant.
- **Improvise a collapse** — implement the fix in the same run and close via `Fixes #N`,
  bending the documented contract. This is exactly what happened with investigation #33
  (the T3 startup hang, which resolved into a one-line `AbortSignal.timeout` on the
  readiness poll): the operator directed the agent to collapse investigation+fix into one
  PR. The convention had no rule, so the agent improvised on instruction.

Either way the **per-stage contract** — the property that makes the suite trustworthy,
that two agents hitting the same seam behave the same way — erodes precisely where an
investigation meets a cheap fix. This is the seam #118 asks us to close: pick a path and
write it down so agents stop improvising.

## Options considered

### (a) Collapse path — write-code MAY implement + PR directly, bounded

When an investigation has resolved into a fix that meets a **bounded** definition of
"trivial," write-code skips the `report` round-trip and instead opens a PR with
`Fixes #N` in the same run — the diagnosis lives in the PR body / a progress comment, and
the `review-code` gate verifies the fix against the investigation's own stated cause as
the acceptance criterion. The collapse is a **named exception inside write-code**, not a
silent one. The bound must be tight enough that the exception can't be stretched into "I
felt like fixing it."

- **For:** Keeps the decision and its enforcement in *one* skill (write-code), where the
  agent already holds the diagnosis and full context. No cross-stage handoff, no
  re-triage, no two-extra-issue overhead. Retroactively blesses the #33 precedent as the
  sanctioned shape rather than a one-off. The fix is still **independently gated** by
  `review-code` — collapsing the *intake* hops does not collapse the *verification*.
- **Against:** Introduces a judgment call ("is this trivial?") into write-code. Mitigated
  by a hard, checkable bound (below) so the call is mechanical, not taste.

### (b) Re-type path — triage flips investigation → bug/chore once the cause is known

Once the fix is known, the investigation issue is **re-typed** (investigation →
`bug`/`chore`) and re-enters as normal pickable work, with no fresh `report`. The re-type
step lives in triage.

- **For:** Preserves the strict "investigations don't merge a PR" letter — the merge
  happens on a `bug`/`chore`, not an investigation. Keeps type→behavior one-to-one.
- **Against:** The cause is discovered in **write-code** (mid-investigation), but the
  re-type authority lives in **triage** — so the fix still bounces stages: write-code
  pauses, hands back to triage to re-type, triage hands back to write-code to implement.
  That is the same ping-pong (a) removes, only routed through a different stage. It also
  blurs triage's job: triage classifies *intake*, it does not adjudicate a half-finished
  investigation's findings.

### (c) Neither — keep the strict residue path

Keep `report → triage → write-code` for all investigation residue, including a trivial
fix. Accept the ceremony as the price of a uniform contract.

- **For:** Zero new rules; every fix flows through identical intake.
- **Against:** Pays the worst cost of the three for the most common terminal case, and
  — proven by #33 — does **not** actually hold: when the ceremony is plainly
  disproportionate, operators and agents route around it, which is how the contract erodes
  in the first place. A rule that is predictably bypassed is worse than a narrow,
  explicit exception.

## Decision

**Adopt (a): the bounded collapse path, owned by write-code.**

When a `type:investigation` issue resolves into a fix, write-code MAY implement it and
open a PR with `Fixes #N` in the **same run** — *if and only if* the fix clears **every**
bound below. If it fails **any** bound, write-code falls back to the existing
diagnosis-and-`report`-residue path (status quo). The bound is a hard gate, AND-ed, not a
vibe:

1. **Single concern, narrowly scoped.** The fix is one logical change in a small,
   reviewable diff (the diagnosis already localized it to one site). A change touching
   many files or many concerns is not a collapse case — file it as residue.
2. **No new behavior, no new surface.** No new public API, route, config key, binding,
   schema/migration, or dependency. The fix restores or corrects *existing* behavior the
   investigation proved wrong.
3. **No contract / control-plane change.** The fix does not touch a control-plane path
   (`.claude/**`, `.github/**`, or a gate-critical skill — ADR
   [0053](0053-control-plane-boundary.md) / [0065](0065-gate-critical-skills-are-blocking.md)).
   Anything control-plane is never a collapse; it takes the full path and a human merge.
4. **Cause is established, fix is unambiguous.** The investigation's diagnosis names the
   root cause and the fix follows directly from it — there is no remaining design choice.
   If the fix opens a design question, it is not trivial: record/route it, don't collapse.

The collapse is **explicit, not silent**: the PR body states it is a collapsed
investigation, links the issue, and carries the diagnosis (the verdict the closing comment
would otherwise have held) so `review-code` can verify the fix against the cause as its
acceptance criterion. **Verification is not collapsed** — the PR is independently gated by
`review-code` exactly like any other PR; only the *intake* hops (`report → triage`) are
skipped. Residue that does **not** clear the bound is still filed as fresh `report` issues,
unchanged.

This path lives in **write-code**, not triage: the cause is discovered in write-code, the
agent holds the context, and keeping the rule there avoids the cross-stage ping-pong that
sinks option (b). The shared statement of the rule joins the intake contract in
`skills/gh-issue-intake-formats.md` so every skill references one source, and write-code's
`type:investigation` routing cross-references it.

**The #33 precedent (collapsed PR with `Fixes #33`) is retroactively blessed** as the
sanctioned shape this rule now names — it is the worked example, not a one-off.

## Consequences

- **The common terminal case stops costing three hops.** An investigation that ends in a
  trivial, proven fix becomes one PR in one run, still independently `review-code`-gated.
  Agents stop improvising at this seam — the rule is written, the bound is checkable, two
  agents behave the same way.
- **The exception cannot be stretched.** The four AND-ed bounds (single concern · no new
  surface · no control-plane · unambiguous fix) make "trivial" mechanical. Anything that
  fails a bound — a multi-file change, a new surface, a control-plane edit, a lingering
  design choice — falls back to the diagnosis-and-residue path automatically.
- **triage's job stays clean.** triage continues to classify intake; it does **not** gain
  an investigation-re-type step (option b rejected), so the re-type ping-pong never enters
  the pipeline.
- **Verification authority is unchanged.** ship-it stays the sole merge actor; collapsed
  investigation PRs flow PASS → merge exactly like any code PR (and, being non-control-plane
  by bound #3, are auto-mergeable on a `review-code` PASS).
- **Implementation is follow-up work.** This ADR records the decision; the edits that make
  it live — write-code's `type:investigation` routing gains the bounded collapse branch,
  the rule is stated in `skills/gh-issue-intake-formats.md`, and triage/write-code
  cross-reference it — touch gate-critical control-plane skills (ADR 0065) and are tracked
  in issue #389 (milestone "Pipeline hardening", `status:needs-triage`).
- **Relationship:** this ADR **amends** the `type:investigation` routing currently in
  `skills/write-code/SKILL.md` by adding the bounded collapse branch. It does not change
  any other type's routing, and it composes with ADR
  [0053](0053-control-plane-boundary.md) / [0065](0065-gate-critical-skills-are-blocking.md)
  — bound #3 explicitly excludes control-plane changes from ever being collapse-eligible.
