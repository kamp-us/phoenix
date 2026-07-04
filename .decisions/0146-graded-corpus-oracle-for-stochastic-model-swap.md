---
id: 0146
title: A graded-over-corpus oracle (pass-rate + repair-churn cost) is the evidence a stochastic model swap needs — extending ADR 0112's binary n=1 gate
status: accepted
date: 2026-07-04
tags: [pipeline, token-economics, measurement, model-tiering, eval-harness]
---

# 0146 — A graded-over-corpus oracle is the evidence a stochastic model swap needs (extending ADR 0112)

## Context

ADR [0112](./0112-token-measurement-no-quality-compromise-methodology.md) codified the
token-cost methodology: a **frozen task set** (one real input per heavy stage), a
`spawn-guard`-grounded **token meter**, and a per-stage **output-quality oracle** that is a
*binary* pass/fail over that single frozen input — did the optimized stage reproduce the
**same decision artifact** as the baseline. That apparatus is exactly right for the lever it
was built for: a **deterministic** change to a stage (a tighter prompt, a thin-core skill, a
read-economics trim). For a deterministic change, one frozen input is a sufficient oracle —
the transformation either preserves the decision path or it doesn't, and n=1 witnesses that.

The token-efficiency program then reached a lever the binary n=1 oracle **cannot** adjudicate:
a **stochastic model swap** — running a stage on a cheaper model (Opus → Sonnet), where the
same input can pass on one run and fail on the next. Against a stochastic stage an n=1 smoke
test cannot separate *"good enough"* from *"got lucky"*: a single PASS is one sample from a
distribution, and a single input measures neither the stage's **pass-rate** across the space
of real inputs nor the **downstream token cost** of the FAILs a cheaper model forces. A model
that is cheaper per run but fails the gate more often forces extra write-code→review→repair
cycles, and those cycles burn tokens the per-run saving never counted — the epic's headline
risk. ADR 0112 §4's veto ("a quality regression vetoes the lever regardless of the token win")
is the right rule, but its §3 oracle has no *statistical* form to apply it against a model
whose output is a distribution rather than a fixed artifact.

Epic [#1842](https://github.com/kamp-us/phoenix/issues/1842) built the apparatus that supplies
that statistical evidence: the [`eval-harness`](../packages/pipeline-cli/src/tools/eval-harness)
tool. This ADR records the durable *why* — what graded-over-corpus measurement is and why a
stochastic model swap requires it — extending 0112's method to the stochastic case. It records
**no** per-swap numbers (those live on the lever/decision children, per 0112's division of
surfaces) and it does **not** decide the tiering policy — that is
[#1576](https://github.com/kamp-us/phoenix/issues/1576), the downstream decision this
apparatus feeds.

## Decision

Extend ADR 0112's binary n=1 oracle to a **graded oracle over a labeled corpus** as the
evidence standard for a **stochastic** stage change (a model swap). Where 0112 §3 grades one
frozen input to a binary PASS/FAIL, the graded apparatus grades **many** labeled inputs per
stage and reduces the grades to two aggregate axes:

1. **A labeled corpus per stage — the generalization of 0112 §1's frozen input.** Instead of
   one pinned input per stage, a **corpus** of pinned inputs spanning the happy path plus at
   least one edge/error class (a real `review-code: FAIL`, a red-CI write-code). Each entry
   carries the **recorded baseline decision artifact** as its ground-truth label. Same
   representative-task-set discipline as 0112 §1 (reproducible-from-identifier, pinned to the
   recorded state, append-only growth) — scaled from n=1 to a set large enough that a rate is
   meaningful. This is the committed ground truth under
   [`eval-harness/corpus/`](../packages/pipeline-cli/src/tools/eval-harness/corpus).

2. **A graded oracle — the generalization of 0112 §3's binary oracle.** 0112 §3's per-stage
   oracle (did the stage reproduce the same decision artifact) is applied **per corpus entry**,
   yielding a per-(stage × model) **pass-rate**: the fraction of graded runs whose observed
   artifact reproduces its recorded label. A pass-rate is the statistic n=1 cannot supply —
   it distinguishes a model that reliably reproduces the baseline from one that got lucky once.

3. **A repair-churn cost — the token axis a stochastic swap adds.** 0112 §2's token meter
   prices a stage's spend on **one** run. A stochastic swap needs the **net** token cost that
   the per-run saving hides: a cheaper model that fails more often forces extra
   write-code→review→repair cycles, each burning tokens. The harness prices that churn as a
   geometric expectation of extra cycles from the measured pass-rate
   (`expectedExtraCycles = (1 − passRate) / passRate`, `churnTokens = expectedExtraCycles ×
   tokensPerRepairCycle`), so a swap is judged on `amortizedTokensPerRun = tokensPerRun +
   churnTokens`, not the per-run delta alone. A **negative** `netSaving` is the crossover the
   binary-per-run gate cannot see — the cheaper model loses tokens net once its churn is priced
   in. All token inputs reuse 0112 §2's four-`usage`-component reconstruction over a stage's
   `agent-<id>.jsonl` transcript (the existing `token-spend` core, read-only) — the harness
   mints **no** second meter.

**The standing rule is unchanged; only the oracle's form generalizes.** ADR 0112 §4's two-axis
veto still governs: a token reduction that degrades quality is a fail, not a win. For a
stochastic swap the two axes are the **net** token axis (amortized over repair churn) and the
**graded** quality axis (pass-rate no-regression over the corpus) — the same "same-or-better
output, fewer tokens" bar, made checkable against a distribution instead of a fixed artifact.
As under 0112, this ADR carries **no** measured numbers; a swap's pass-rate and net-token
verdict live on the decision that cites them (#1576).

## Consequences

- **A stochastic model swap now has a sufficient oracle.** The binary n=1 oracle of 0112 §3
  cannot adjudicate a model whose output is a distribution; the graded corpus + pass-rate +
  repair-churn cost is the evidence #1576 (and any future per-stage tiering call) must cite,
  the same way a deterministic lever cites the 0112 apparatus. No model swap is adopted on an
  n=1 PASS or a per-run token saving alone.
- **This extends 0112, it does not supersede it.** The binary n=1 oracle remains the right
  tool for a **deterministic** stage change (tighter prompt, thin-core skill, read-economics);
  the graded corpus is the tool for a **stochastic** change (model swap). Both hold 0112 §4's
  veto; the graded form is the statistical generalization applied where the input is
  distributional.
- **The apparatus is recorded where the next agent finds it.** The runnable entry point (the
  committed corpus + the `eval-harness check` validator today; the `eval-harness report`
  two-axis scorecard once #1853 lands) and the *how* live in
  [`.patterns/token-economics-measurement.md`](../.patterns/token-economics-measurement.md) §8,
  cross-linked from this ADR — the same division of surfaces 0112 established (this ADR owns
  the *why*, the pattern owns the *how* + the numbers).
- **This ADR decides nothing about tiering.** Whether any stage runs on a cheaper model is
  [#1576](https://github.com/kamp-us/phoenix/issues/1576)'s call, made **on** this apparatus's
  output — explicitly not resolved here. This record supplies the measurement method the
  decision will cite, nothing more.
