---
id: 0112
title: Token-Cost Reduction Methodology — A Frozen Task Set, a Reproducible Token Meter, and a No-Quality-Compromise Gate (Quality Regression Vetoes the Lever)
status: accepted
date: 2026-06-27
tags: [pipeline, token-economics, methodology, measurement]
---

# 0112 — Token-Cost Reduction Methodology — A Frozen Task Set, a Reproducible Token Meter, and a No-Quality-Compromise Gate (Quality Regression Vetoes the Lever)

## Context

The kamp.us pipeline is run by a fleet of autonomous agents (triage, write-code,
review-\*, the sub-agent fan-out the triage loop drives — 1–9 agents per batch, each
reading source to ground its verdict). Every read and prompt is paid for in tokens, and
spend scales with how hard we lean on the pipeline. The maintainer flagged it directly —
"we are burning like crazy" — which became epic
[#1356](https://github.com/kamp-us/phoenix/issues/1356) (milestone #15, "Token efficiency
— zero quality compromise"). The epic set one hard constraint: **no quality compromise —
the bar is "same or better output, fewer tokens."**

That epic established a *method* for cost-reduction work and then proved it against real
pipeline surfaces. Two worked instances now live on `main`:

- the **measurement apparatus** —
  [`.patterns/token-economics-measurement.md`](../.patterns/token-economics-measurement.md)
  (the #1370 baseline: the frozen task set, the `spawn-guard`-grounded token procedure,
  the output-quality rubric, plus the recorded "before" numbers);
- the **ranked audit map** —
  [`.patterns/token-economics-audit.md`](../.patterns/token-economics-audit.md) (the #1371
  attributed breakdown of where a stage's tokens actually go, built on the apparatus).

Without recording the method itself, the next cost effort would re-derive the apparatus
from scratch — pick fresh inputs (so before/after is no longer apples-to-apples), reinvent
the token-count procedure, and re-argue what "no quality compromise" means in practice. The
risk that prompted the epic was *premature optimization* — adopting a lever for savings
never verified against a quality the change never measured. A recorded methodology is what
makes that risk un-repeatable: future levers **reuse** the apparatus rather than re-deriving
it. This ADR codifies the durable *why* and method; it re-states **no** per-lever numbers
(those live on the lever children) and invents **no** new policy beyond what the epic
established.

## Decision

Cost-reduction work on the pipeline follows the methodology this epic established and
proved. Four parts, one discipline — the first three are the reusable apparatus, the fourth
is the standing rule that gates every lever:

1. **Representative-task-set discipline — frozen inputs, apples-to-apples.** Measure against
   a small, fixed, named set of real pipeline inputs (one per heavy stage), chosen to be
   stable and reproducible from their identifiers alone. A lever's before/after is only
   comparable when both runs consume the **same** input, so the set is pinned by identifier,
   not "a recent issue"; when a frozen input later mutates, the comparison pins to the
   recorded state, not the live one. The canonical set lives in
   [`.patterns/token-economics-measurement.md` §1](../.patterns/token-economics-measurement.md).

2. **Reproducible token-measurement procedure — grounded in `spawn-guard`, not intuition.**
   The authoritative per-run figure is Claude Code's own `cost.total_tokens` /
   `cost.total_cost_usd` aggregate, exactly what the existing
   [`spawn-guard`](../packages/pipeline-cli/src/tools/spawn-guard) statusline reader already
   prints — reuse that meter read-only, never mint a new one. Because that aggregate is not
   persisted into a transcript, an **offline reconstruction** reproduces it from a stage
   sub-agent's own transcript
   (`<parent-session-id>/subagents/agent-<agent-id>.jsonl`) by summing the **four `usage`
   components** Claude Code itself aggregates over every assistant message —
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`.
   Keep the four-way breakdown visible (`cache_read` is re-charged every turn and dominates
   the headline; the `ex-cache-read` figure is the better cross-run comparator). The full
   procedure, the `jq` one-liner, and the recorded baseline are in
   [`.patterns/token-economics-measurement.md` §2](../.patterns/token-economics-measurement.md);
   the attribution layer over it is
   [`.patterns/token-economics-audit.md`](../.patterns/token-economics-audit.md).

3. **Output-quality rubric — the no-compromise constraint made checkable.** Each frozen
   input carries a per-stage quality oracle: a reproducible pass/fail that asserts the
   optimized stage produces the **same decision artifact** as the baseline (same triage
   classification, same `Fixes #N` + green CI + independent `review-code: PASS` for
   write-code, same verdict + same AC findings for review-code). The rubric is what turns
   "quality preserved" from an assertion into a check. It is defined in
   [`.patterns/token-economics-measurement.md` §3](../.patterns/token-economics-measurement.md).

4. **The standing rule — a token reduction that degrades quality is a fail, not a win.**
   Every lever is judged on **two axes simultaneously, and both must hold**: a real measured
   token reduction against the recorded baseline (§2), *and* the output-quality rubric (§3)
   showing accuracy **preserved or improved** on the same frozen set. **A quality regression
   vetoes the lever regardless of the token savings** — the change is rejected/reverted, not
   shipped. "Same or better output, fewer tokens" is the whole bar; a saving bought with a
   different classification, a lost acceptance criterion, or a changed verdict is not a
   saving, it is a regression. This veto is non-negotiable and is carried as an explicit
   acceptance criterion on every lever child.

This methodology is the reusable standard for future pipeline cost work: reuse the apparatus
(§1–§3), and hold the gate (§4).

## Consequences

- **Future cost work reuses, never re-derives.** The next cost effort starts from the frozen
  set, the `spawn-guard`-grounded procedure, and the rubric already proven in the two
  worked-instance patterns — not from scratch. Apples-to-apples before/after is preserved
  across efforts because the inputs and the meter are fixed and recorded.
- **No lever ships on a token win alone.** The quality gate is a hard veto: a measured token
  reduction is necessary but not sufficient. This forecloses the premature-optimization risk
  that prompted the epic — savings can no longer be banked without verifying the quality they
  were bought against.
- **The method is grounded, not asserted.** Measurement rests on Claude Code's own
  aggregate via the existing `spawn-guard` meter and the four-component `usage`
  reconstruction, per CLAUDE.md's "ground falsifiable runtime claims in source" — not on a
  hand-rolled or intuited token count.
- **Division of surfaces.** This ADR owns the durable *why* + the standing rule; the
  `.patterns/` docs own the *how* (the live procedure, the `jq`, the recorded numbers) and
  stay the place a future agent reads to run the apparatus. Per-lever numbers stay on their
  lever children — this record deliberately carries none, so it doesn't go stale as the
  pattern docs' measured numbers are refreshed.
</content>
</invoke>
