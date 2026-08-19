---
id: 0234
title: A usage-miss prints nothing, or exactly the script's declared restrictive sentinel
status: accepted
date: 2026-07-31
tags: [pipeline, skills, shell, gates]
---

# 0234 — A usage-miss prints nothing, or exactly the script's declared restrictive sentinel

**What this decides:** When a pipeline skill script is run without its required arguments, its
stdout may carry one of exactly two things: nothing at all (the default), or — for a script whose
stdout a call site reads as a safety value — the one restrictive sentinel the script declares; and
the extraction verifier's usage-miss check verifies each script against its own declaration instead
of demanding silence from everyone.

## Context

Two documented, deliberately fail-closed conventions pointed opposite ways on the same code path,
and a verifier enforced one of them against scripts built to the other (#4584):

- **`verify-extraction.sh` check 9**
  (`claude-plugins/kampus-pipeline/skills/plan-epic/scripts/verify-extraction.sh`,
  the block under `# 9. a usage miss is non-zero with EMPTY stdout`): a script run with no
  arguments must exit non-zero with **zero bytes on stdout**, so a could-not-run can never pose as
  an answer.
- **`review-code`'s error-channel rule**
  (`claude-plugins/kampus-pipeline/skills/review-code/SKILL.md`,
  the error-channel bullet): a script whose **stdout answers a safety question** prints its own
  fail-closed sentinel on stdout before every early exit, because where a caller reads absence as a
  positive answer, a silent guard exit is indistinguishable from "proven safe" (the fail-closed
  zero-scope rule, ADR [0092](0092-gates-fail-closed-on-zero-scope.md) §ZS).

The collision was live and value-sensitive, not cosmetic. Check 9 reds on six `review-code`
scripts (`classify-control-plane.sh` 118 B, `classify-issueless.sh` 107 B,
`classify-skills-only.sh` 80 B, `containment-marker.sh` 4 B, `glossary-freshness.sh` 127 B,
`userfacing-scope.sh` 327 B). For `containment-marker.sh` the stakes were a live dark-ship gate:
its usage guard deliberately prints `flag` (ARMED) because `none` is the SKIP answer, and its call
site (review-code Step 3b) captures **stdout only** and gates on the **value**. Reproduced on main
`f1553968`: the script as shipped resolves a usage-miss to `exit=2 stdout=[flag]` → ARMED,
fail-closed; a mechanically check-9-satisfying edit resolves it to `exit=2 stdout=[]` → skip,
fail-**open** — the containment gate silently disarmed while every downstream gate reports green.
Left unresolved, the six scripts sat permanently red against the verifier that is the extraction
bar for epic #4435, which is exactly the pressure that produces the mechanical greening.

A founder ruling (recorded verbatim on #4584) picked shape (1) — check 9 accepts a **declared**
restrictive sentinel — over shape (2), narrowing check 9's scope to scripts whose stdout is not a
safety answer. This ADR records that ruling. The stdout/stderr contract this amends in part is the
#4510-lineage IO contract doc
([`.patterns/skill-script-io-contract.md`](../.patterns/skill-script-io-contract.md), landed via PR
#4577), whose exit taxonomy currently reads non-zero as "stdout: nothing" unconditionally — issue
#4618 records the declared-sentinel convention there.

## Decision

**A usage-miss must exit non-zero and print on stdout either nothing (the default, silent class) or
exactly the script's declared restrictive sentinel and nothing else (the safety-answer class);
`verify-extraction.sh` check 9 verifies against the declaration.**

Two classes, one rule:

- **The silent class (default).** A script whose stdout no call site reads as a safety value: a
  usage-miss exits non-zero with zero bytes on stdout, exactly as check 9 asserts today.
- **The safety-answer class.** A script whose stdout a call site reads as a safety value (the
  `containment-marker.sh` shape: the value, not the exit status, is what the call site gates on): a
  usage-miss exits non-zero and prints **exactly the script's declared restrictive sentinel and
  nothing else** — the answer that holds the guard armed, never the one that skips it.
- **The declaration is what makes the rule checkable.** A safety-answer script *declares* its
  restrictive sentinel; check 9 verifies the usage-miss emission against that declaration — for a
  script with a declared sentinel, exactly that sentinel; for all others, empty stdout as today.
  Conformance is mechanical, not judged per-review.

Why shape (1) over shape (2), recorded so no one relitigates: narrowing check 9's scope would leave
the **most dangerous** class — safety-answer scripts — with no usage-miss verification at all.
Shape (1) keeps the check's teeth on both classes, matches the error-channel rule's own
discriminator text ("the discriminator on a completed run is the **absent sentinel line**, not
empty stdout"), and makes conformance mechanically checkable via the declaration.

**Binding constraints.**
- All six red call sites get the exit-status-vs-value audit **before** any script changes.
- `containment-marker.sh`'s usage-miss must still resolve to ARMED at its call site after
  reconciliation.
- The declared-sentinel convention is recorded in the #4510-lineage IO contract doc
  ([`.patterns/skill-script-io-contract.md`](../.patterns/skill-script-io-contract.md)).
- Check 9 verifies against the declaration; a script with no declared sentinel stays under the
  empty-stdout assertion unchanged.

**Banned.**
- Deleting or weakening a value-sensitive sentinel to green check 9 — the check must never be
  satisfiable by the fail-open edit.

## Consequences

- Both script classes keep usage-miss verification; the permanently-red-verifier pressure that
  invites mechanical greening is removed by making the compliant shape expressible, not by
  loosening the bar.
- The verifier gains a small obligation: reading each script's sentinel declaration. In exchange
  the fail-open edit (delete the sentinel, keep the empty-stdout green) becomes a check FAIL by
  construction instead of a per-review judgment call.
- The IO contract doc's exit taxonomy ("non-zero → stdout: nothing") is **amended in part** by the
  safety-answer class; the doc is a pattern doc, so it is corrected in place by #4618, no
  supersession mechanics needed.
- **The reconciliation build is explicitly not this ADR's scope** — amending check 9, recording the
  convention in the IO contract doc, and the six-site exit-status-vs-value audit are carried by
  issue **#4618**. This ADR is the recorded ruling those changes implement; until #4618 lands, the
  ruling is recorded but not yet mechanized, and the six scripts stay red against check 9.

## Records

- Closes #4584 for its first acceptance criterion only — the collision is ruled on and recorded as
  an ADR. #4584's remaining three criteria (reconcile check 9 to this ruling; audit the six red
  call sites for exit-status-vs-value sensitivity; the verifier reporting no check-9 FAILs with
  `containment-marker.sh` still ARMED) are carried **verbatim** by **#4618**, which inherits them
  when this PR closes #4584. The founder ruling split the ownership of that work, not the
  obligation.
- Vocabulary impact: coins **declared restrictive sentinel** (and the two usage-miss classes,
  *silent* / *safety-answer*) — routed to
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) (Run-evidence / CI gating section) in this PR.
