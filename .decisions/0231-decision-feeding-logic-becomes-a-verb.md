---
id: 0231
title: Scripts sequence and relay verbs; decision-computing logic becomes a verb
status: accepted
date: 2026-07-30
tags: [pipeline, skills, tooling]
---

# 0231 — Scripts sequence and relay verbs; decision-computing logic becomes a verb

**What this decides:** For every shell script extracted from pipeline skill markdown — not just the
control-plane merge guards — a script may run `pipeline-cli` verbs in order and pass their answers
along, but any logic that itself *computes* a gate, merge, or classification decision (a threshold,
a precedence between disagreeing verbs, a tie-break, a regex that reinterprets a verb's answer)
must be a tested `pipeline-cli` verb by the end of the glue→verb phase (#1929). How new
decision-deriving shell is kept out of skill markdown afterwards is deliberately not decided here —
that question is deferred to #4527.

## Context

Epic #4435 moves the fenced shell embedded in pipeline skill markdown into sourced `.sh` scripts
(phase 1, a mechanical byte-move), then migrates the ad-hoc `gh`/`jq`/`git` glue inside those
scripts into tested `pipeline-cli` verbs (phase 2, #1929). Issue #4447 asked where sanctioned
orchestration in a script ends and reimplemented decision logic begins, and the epic's ledger
recorded a candidate test without ruling it. ADR
[0228](0228-scripts-relay-never-derive.md) settled the derive-vs-relay boundary for the scripts
extracted under the programme; what remained open on #4447 was whether that boundary, as the ruled
line, settles the question corpus-wide and fixes phase 2's endpoint.

The founder ruled on #4447 (issue comment 5128138133, 2026-07-30): the test is the settled line for
the entire extracted-script corpus and for phase 2's endpoint — "the skill invokes, the script
implements, the verb decides." His ruling sentence phrased the bound logic as logic that "feeds a
gate/merge/classification decision"; that is the exact phrasing ADR
[0228](0228-scripts-relay-never-derive.md) had amended away as a non-discriminator (in a
merge-authority script, almost everything feeds the decision). On this ADR's PR the founder
resolved that tension himself: he consciously narrowed his own ruling sentence to its derive-keyed
intent — the bound set is logic that *computes* such a decision, not everything whose output feeds
one (PR #4533, comment 5128540573). The narrowing carries his sign-off, so it is a ruled reading,
not a drafting liberty. ADR 0228 stands unamended; the "feeds" phrasing stays discarded exactly as
0228's amendment section argued, and this ADR extends 0228's derive-keyed boundary by confirming it
as the corpus-wide answer to #4447 and as phase 2's endpoint (0228's own phase-2 constraint — "any
decision a script still computes itself becomes a verb" — is that same endpoint).

The campaign's own findings are the supporting evidence, cited rather than re-derived: every
fail-open found during the extraction campaign lived in shell that *derived* a decision instead of
relaying a verb's answer — the bash-3.2 errexit+`EXIT`-trap shape (#4479, #4514; recorded in
[`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md)), the repeated
`--require` first-wins drop (#4520), and the unread-file false-clean class (#4497 — the scan
reports clean and exits 0 for a file that does not exist). Decision logic in shell is where the
fail-opens live; relayed verb answers are where they were caught.

Open PR #4526 records a related but distinct decision from a different source — it rules the
two-verbs-combined edge 0228 left open. Its number is settled at 0229 (with 0230 taken by PR #4528
and 0231 by this file); it is cited here by PR number because its file is not yet on `main` to
link.

## Decision

**A script may sequence `pipeline-cli` verbs and relay their outputs — but any logic that computes
a gate, merge, or classification decision must be a verb by end of phase 2 (#1929); shell
orchestrates, it never derives.**

This document carries one test — the derive-keyed test, the #4447 ruling as consciously narrowed by
the founder on PR #4533 (comment 5128540573). It is falsifiable per script, so a phase-2
implementer applies it without relitigation. For each piece of logic in a script, ask two
questions:

1. **Does this logic compute a gate, merge, or classification decision?** The derive family: a
   threshold, a precedence between disagreeing verbs, a tie-break, a regex that reinterprets a
   verb's answer. If no, it is orchestration — sequencing verbs, relaying their outputs, consulting
   a fact, formatting, routing — and may stay in shell.
2. **If yes, is that computation a `pipeline-cli` verb, or does the shell do it itself?** A verb
   consulted and relayed passes. Shell that computes the answer itself is the violation, and by end
   of #1929 that logic becomes a verb.

Worked discriminator, ruled for the record: reading the head SHA with `gh` inside an extracted
merge script **consults** — its output feeds the merge decision, but it computes nothing, so it
stays shell; a script that decides enqueueability from the interplay of two verbs' verdicts
**computes** — it becomes a verb by end of phase 2. "Feeds" is deliberately not the key, because it
does not discriminate these two cases; "computes" does.

This is the phase-2 endpoint, not a phase-1 constraint: phase 1 moves shell out as-is, glue and
all, and nothing here forces verb-ification during the byte-move.

**The enforcement question is deferred, not settled.** How new decision-deriving shell is kept out
of skill markdown going forward — a guard, a review criterion, or a norm — is not decided by this
ADR. The filed follow-up is **#4527**. Rationale for deferring: a new guard is a guard-reshaping
act, and standing practice (ruled on #4505 the same night) is that guard changes get an adversarial
threat-model review of their own, not a ride-along in a decision record.

**Binding constraints.**
- Scope is the whole extracted-script corpus under epic #4435 — ADR
  [0228](0228-scripts-relay-never-derive.md)'s derive-keyed boundary, confirmed corpus-wide.
- By end of phase 2 (#1929), every piece of script logic that computes a gate, merge, or
  classification decision (the derive family above) is a `pipeline-cli` verb; the script sequences
  and relays. This constraint and the two-question procedure are one test, not two.
- Phase-2 work applies this test per script as written; the boundary is not re-litigated per block.
- The enforcement mechanism is decided in #4527, nowhere else.

**Banned.**
- A script computing a gate, merge, or classification decision in shell after phase 2.
- Restating the test in the "feeds a decision" form — ADR 0228 amended that phrasing away, and this
  ADR keeps it discarded.
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

- Records the founder ruling on #4447 (issue comment 5128138133, 2026-07-30), as consciously
  narrowed to its derive-keyed intent by the founder's ruling on PR #4533 (comment 5128540573,
  extend — option (i)). The candidate test originates on epic #4435; this ADR gates phase 2
  (#1929); the deferred enforcement question is #4527.
- Vocabulary impact: **none.** The ruling fixes scope and phase-2 endpoint for the already-coined
  derive-vs-relay boundary (ADR [0228](0228-scripts-relay-never-derive.md)); it coins and
  redefines no term.
