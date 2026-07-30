---
id: 0231
title: Scripts sequence and relay verbs; decision-feeding logic becomes a verb
status: accepted
date: 2026-07-30
tags: [pipeline, skills, tooling]
---

# 0231 — Scripts sequence and relay verbs; decision-feeding logic becomes a verb

**What this decides:** For every shell script extracted from pipeline skill markdown — not just the
control-plane merge guards — a script may run `pipeline-cli` verbs in order and pass their answers
along, but any logic whose output feeds a gate, merge, or classification decision must itself be a
tested `pipeline-cli` verb by the end of the glue→verb phase (#1929); a script must never re-derive
such a decision in shell. How new decision-deriving shell is kept out of skill markdown afterwards
is deliberately not decided here — that question is deferred to #4527.

## Context

Epic #4435 moves the fenced shell embedded in pipeline skill markdown into sourced `.sh` scripts
(phase 1, a mechanical byte-move), then migrates the ad-hoc `gh`/`jq`/`git` glue inside those
scripts into tested `pipeline-cli` verbs (phase 2, #1929). Issue #4447 asked where sanctioned
orchestration in a script ends and reimplemented decision logic begins, and the epic's ledger
recorded a candidate test without ruling it. ADR
[0228](0228-scripts-relay-never-derive.md) settled the derive-vs-relay boundary for the extracted
guard scripts; what remained open on #4447 was whether the candidate test, as recorded, is the
ruled line for the whole corpus and for phase 2's endpoint.

The founder ruled on #4447 (issue comment 5128138133, 2026-07-30): the candidate test is blessed
in the form recorded on epic #4435, as the settled line for the entire extracted-script corpus.
This extends ADR [0228](0228-scripts-relay-never-derive.md) (scripts relay, never derive) from the
guard scope it was ruled in to every script the campaign extracts; 0228 stands, and its
phase-2 constraint ("any decision a script still computes itself becomes a verb") is the same
endpoint this ruling fixes corpus-wide.

The campaign's own findings are the supporting evidence, cited rather than re-derived: every
fail-open found during the extraction campaign lived in shell that *derived* a decision instead of
relaying a verb's answer — the bash-3.2 errexit+`EXIT`-trap shape (#4479, #4514; recorded in
[`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md)), the repeated
`--require` first-wins drop (#4520), and the word-split false-clean class (#4497). Decision logic
in shell is where the fail-opens live; relayed verb answers are where they were caught.

Open PR #4526 records a related but distinct decision from a different source — it rules the
two-verbs-combined edge 0228 left open. Its ADR number is not settled while the PR is in flight,
so it is cited here by PR number only.

## Decision

**A script may sequence `pipeline-cli` verbs and relay their outputs — but any logic whose output
feeds a gate, merge, or classification decision must be a verb by end of phase 2 (#1929); a script
must not re-derive such a decision in shell.**

The test is falsifiable per script, so a phase-2 implementer applies it without relitigation. For
each piece of logic in a script, ask two questions:

1. **Does its output feed a gate, merge, or classification decision?** If no, it is orchestration —
   sequencing verbs, relaying their outputs, formatting, routing — and may stay in shell.
2. **If yes, is that logic a `pipeline-cli` verb, or does the shell compute the answer itself?** A
   verb consulted and relayed passes. Shell that re-derives the answer — matching a boundary regex,
   re-implementing a classification, re-deriving a gate's arithmetic — is the violation, and by end
   of #1929 that logic becomes a verb.

This is the phase-2 endpoint, not a phase-1 constraint: phase 1 moves shell out as-is, glue and
all, and nothing here forces verb-ification during the byte-move.

**The enforcement question is deferred, not settled.** How new decision-deriving shell is kept out
of skill markdown going forward — a guard, a review criterion, or a norm — is not decided by this
ADR. The filed follow-up is **#4527**. Rationale for deferring: a new guard is a guard-reshaping
act, and standing practice (ruled on #4505 the same night) is that guard changes get an adversarial
threat-model review of their own, not a ride-along in a decision record.

**Binding constraints.**
- Scope is the whole extracted-script corpus under epic #4435, not only the guard scripts ADR
  [0228](0228-scripts-relay-never-derive.md) was ruled in.
- By end of phase 2 (#1929), every piece of script logic whose output feeds a gate, merge, or
  classification decision is a `pipeline-cli` verb; the script sequences and relays.
- Phase-2 work applies this test per script as written; the boundary is not re-litigated per block.
- The enforcement mechanism is decided in #4527, nowhere else.

**Banned.**
- A script re-deriving a gate, merge, or classification decision in shell after phase 2.
- Settling the enforcement (guard-vs-norm) question in passing, without the adversarial
  threat-model review a guard change requires.

## Consequences

- Phase 2 (#1929) is unblocked with one settled, per-script-applicable line instead of a per-block
  argument at every migration.
- The fail-open classes the campaign found (#4479/#4514, #4520, #4497) become structurally harder
  to reintroduce: the decision-bearing logic moves into tested verbs, and shell keeps only the
  sequencing and relaying that cannot silently invert an answer.
- Enforcement lags the ruling by design: until #4527 is decided, nothing mechanical stops new
  decision-deriving shell from landing in skill markdown — the deferral trades that window for a
  properly threat-modeled guard decision.

## Records

- Records the founder ruling on #4447 (issue comment 5128138133, 2026-07-30). The candidate test
  originates on epic #4435; this ADR gates phase 2 (#1929); the deferred enforcement question is
  #4527.
- Vocabulary impact: **none.** The ruling fixes scope and phase-2 endpoint for the already-coined
  derive-vs-relay boundary (ADR [0228](0228-scripts-relay-never-derive.md)); it coins and
  redefines no term.
