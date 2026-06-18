---
id: 0084
title: Investigation Discipline — Source-Grounded, Right-Scoped, Reconciled
status: accepted
date: 2026-06-18
tags: [process, investigation, epic, adr]
---

# 0084 — Investigation Discipline: Source-Grounded, Right-Scoped, Reconciled

## Context

Epic [#563](https://github.com/kamp-us/phoenix/issues/563) was nearly built on a
wrong diagnosis. The errors all had the same shape — a conclusion driving a
decision was reached by *inference* (from a log label, a file name, a stale read)
rather than grounded in the actual source or platform, and was not cross-checked
against the investigation it contradicted:

- A "`alchemy dev` binds a local D1" conclusion — inferred from logs and a
  stray on-disk sqlite file — was **wrong**, and epic #563's first body was
  written on it. Only a source-grounded investigation (reading the installed
  alchemy provider source + `lsof` on the live dev `workerd`) overturned it: dev
  binds the **real remote** D1 and the orphaned `.wrangler/` sqlite is never
  opened (recorded in [0082](0082-two-test-tiers-unit-integration.md)).
- A diagnostic agent later inferred a "shared-physical-resource race" from CI log
  *labels* — corrected only when another agent traced the actual installed
  `alchemy` source and found the real lifecycle bug.
- Even the guardrail-audit and the orchestrator made **stale / narrow** reads —
  claimed a file was gone repo-wide when it survived in `packages/preview-seed`.
  A narrow `apps/web`-only grep cannot ground a repo-wide claim.

CLAUDE.md already carries the same principle for one stage: *"ground Effect
API/design decisions in effect-smol's `LLMS.md` over intuition."* What was
missing is the cross-stage analog — the same discipline applied to
**investigations**, whose output is upstream of decisions, ADRs, and epic bodies.

## Decision

A `type:investigation` whose output will drive a decision, an ADR, or an epic
body MUST satisfy three obligations:

1. **Source-grounded conclusion.** Ground the conclusion in the actual source or
   platform — the installed dependency code, a reproduction, a live-process check
   — **not** inference from log labels, file-name heuristics, or intuition. When a
   documented source and a plausible-sounding inference conflict, the source wins.

2. **Right scope.** Verify at the scope of the claim. A claim about the repo is
   grounded only by a repo-wide / cross-package check; a narrow `apps/web`-only
   grep that misses `packages/**` is an **ungrounded** claim, not a smaller true
   one.

3. **Reconciled contradictions.** A conclusion that contradicts a prior
   investigation's must identify **which is source-grounded and why** before
   either drives a decision. An unreconciled contradiction is an open question,
   not a finding.

The obligation is **inherited**: an epic or ADR built on an investigation's
premise carries it. `plan-epic` must not decompose, and `/adr` must not accept, a
body resting on an unverified empirical premise — the premise is part of what is
being reviewed, not a given.

## Consequences

- This is the **cross-stage analog** of CLAUDE.md's *"ground Effect decisions in
  `LLMS.md` over intuition"* rule, extended from the design stage to the
  investigation stage that feeds it. Same spirit, one stage earlier: the
  documented / observed source outranks the clean-sounding inference.

- **Now expected** of an investigation that feeds a decision: cite what was
  *read or run* to reach the conclusion (the source file, the repro, the
  `lsof`/log evidence), at the scope the claim is made, with any contradicting
  prior investigation named and resolved. An investigation that only *infers* is
  incomplete for decision-driving use, however plausible it reads.

- **Now banned:** letting a decision, ADR, or epic body rest on an inferred
  empirical premise that was never grounded; backing a repo-wide claim with a
  scope-narrow check; acting on a finding that contradicts a prior one without
  first establishing which is source-grounded.

- **Cost:** an investigation that drives a decision pays for one grounding step
  (read the source / run the repro / check the live process) it could otherwise
  skip. This is deliberate — epic #563 is the worked example of what skipping it
  costs: a decomposed epic body written on a wrong premise, caught late.

- This is a **principle, not a process.** No new label, gate, or template — it
  sharpens what `type:investigation`, `plan-epic`, and `/adr` already do, and
  gives a reviewer the standard to reject an ungrounded premise by.

Extends the CLAUDE.md "ground Effect decisions in `LLMS.md`" convention to
investigations. Precipitated by epic
[#563](https://github.com/kamp-us/phoenix/issues/563); see
[0082](0082-two-test-tiers-unit-integration.md) for the source-grounded
investigation that overturned the inferred diagnosis.
