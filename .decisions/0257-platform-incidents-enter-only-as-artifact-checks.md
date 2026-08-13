---
id: 0257
title: a platform incident is eval material only through an artifact, at the deterministic tier
status: accepted
date: 2026-08-10
tags: [fabrika, eval, decisions]
---

# 0257 — a platform incident is eval material only through an artifact, at the deterministic tier

**What this decides:** harness and platform breakages — a merge queue wedging, a worktree that will not
provision, a stale cache, a CI check armed wrong — are not eval cases. They only reach the eval bar
when the failing behaviour shows up in something a skill or CLI run actually wrote (a verdict, an exit
status, a file), and then only as a deterministic CLI check, never as a spawn-a-skill graded case.
Everything else routes to CI guards and regression tests. Milestone #44's "green at 1.0 scope" is not
widened by this.

## Context

The [#4634](https://github.com/kamp-us/phoenix/issues/4634) sweep raised this as its own calibration
flag 6: many of the ruled KEEP incidents are *harness-level* — merge-queue and CI semantics, worktree
provisioning, turbo cache reuse — not a single skill's behaviour, and the v2 eval bar never said
whether that class is in scope. The [#4642](https://github.com/kamp-us/phoenix/issues/4642) ruling
applied flags 1–5 and is silent on 6. [#4824](https://github.com/kamp-us/phoenix/issues/4824) is the
fork that carries the question; [#4823](https://github.com/kamp-us/phoenix/issues/4823) is the
enumeration that scopes it (66 members).

It is not a cosmetic call. Milestone #44's completion condition is load-bearing on it — *"this campaign
closes when the #4637-B eval bar reads green at 1.0 scope"* — so if platform regressions are in scope,
"1.0 scope" silently grows a class the harness has no way to stage, and the only active campaign gains
a closing condition nobody can reach.

**Two rulings already exist on the issue, and this record is downstream of both, not a re-decision.**

1. **The founder ruling, 2026-08-03** (#4824 comment 5164545723). A harness- or platform-level
   regression is not eval material: the skill made no decision and could not have behaved otherwise.
   But the cut is not "platform vs skill" — it is **did an agent choose something?** Where a platform
   failure is followed by an agent's *response*, the response is in scope and the case is written about
   the response, never about the failure that triggered it. Worked examples: #3954 (two runs improvised
   two different workarounds around the isolation verifier), #4110 (a shipper hand-discharged guards
   during an outage), #4818 (a lane did not notice a 127-with-empty-stdout and ran its whole build with
   no preflight, no claim guard, no verified push). The stated reason is cost, not tidiness: the ruled
   bar is a 100% regression floor and 90% graded, and platform variance inside a graded suite moves the
   number for reasons unrelated to skill quality. That was demonstrated the same day — one flaky
   subprocess test (#4847) ejected three PRs (#4835 twice, #4853 once).
2. **The founder-delegated ruling, 2026-08-09** (#4824 comment 5233197170, chief-of-staff under the
   standing trust ruling, founder informed live with veto open). It picks the issue's option 2 with
   option 1 as the spillover route, states the per-row rule reproduced in §1 below, and confirms
   milestone #44's completion condition is **not** widened.

The nearest live ADRs rule on different questions and are not re-decided here: ADR
[0252](0252-grading-chain-dispersion-and-decline-criterion.md) defines what the graded axis *reports*,
ADR [0243](0243-review-eval-stage-surface-discriminator.md) how a `review` stage is *keyed*, and ADR
[0249](0249-skill-trigger-coverage-lives-in-the-eval-set.md) what a *skill's own* eval set must cover.
None of them says which incidents are admissible to the incident corpus, which is this record's question.

This ADR is the durable home for those two rulings and the composition between them. It decides nothing
they did not; what it adds is the mechanism that makes the rule checkable in this repo's code, and one
named residue where the two rulings do not fully overlap (§Deviations).

## Decision

**A harness or platform breakage is never itself an eval case; it reaches the eval bar only when the
failing behaviour is observable in an artifact a skill or CLI run produced, and such a case enters at
the deterministic CLI tier only — never as a spawn-a-skill graded case.**

### 1. The rule a case author applies per row

> An incident is eval-bar material iff the failing behaviour is observable in an artifact a skill or CLI
> run produces (a verdict, an exit status, a written file) — such cases enter at the **deterministic CLI
> tier only**, never as spawn-a-skill graded cases; incidents whose failing behaviour lives in platform
> mechanics the harness cannot stage (merge-queue semantics, worktree provisioning, cache reuse, CI
> check arming) are **out of the eval bar** and route to CI guards / regression tests instead.

It is a rule applied per row at case-authoring time, not a bucket. The "~22 harness/platform items"
figure in the parent report stays what #4824 says it is — a candidate from one read-only pass, never
re-derived against the enumerated 66 — and nothing here converts it into a count. A stated rule is
cheaper than a re-derived bucket and does not rot.

### 2. What the founder's "the failure is the setup, the response is the case" means here

The two rulings compose in one direction: the founder ruling says *which half of an incident the case is
written about*, and the delegated ruling says *what admits that half and where it runs*. So for a
platform-originated incident:

- Write the case about the agent's **response**, never about the breakage. "The merge queue wedged" is
  not a case; "the shipper discharged its guards by hand" is the candidate.
- Admit that response only if it left a **trace a run produced** — the improvised workaround's own
  output, the guard's exit status, the missing preflight line in a lane's log.
- Word its expectations mechanically, so it lands at the deterministic tier.

### 3. The tier is derived, so the rule is self-enforcing — a graded platform case cannot be authored honestly

A case's tier is not a field an author declares. `deriveTier`
(`packages/fabrika-cli/src/eval/skill-eval-set.ts`)
returns `deterministic` only when a case has assertions and **every one** of them classifies as
mechanical, and `graded` otherwise — including for a case with no assertions at all. Mechanical means
the assertion's text hits one of the cue phrases for an observable: an exit status, a file artifact, a
content match, which script ran.

That gives the rule teeth without a new gate. If a platform-originated incident cannot be worded so that
every expectation names an observable, `deriveTier` returns `graded` — and under §1 a graded platform
case is not admissible, so **the derived tier is the signal that the incident is out of scope, not a
licence to file it graded.** The corpus data test
(`incident-corpus.data.unit.test.ts`) already checks the derived tier against the declared one, so a
case that drifts across that line cannot land quietly.

The committed corpus already sits where the rule puts it: of the 17 cases in
`packages/fabrika-cli/src/eval/incident-corpus/provenance.json` at this commit, 16 are `deterministic`
and 1 is `graded` — case 9, whose `tierRationale` is that its observable is a rule's *justification*
(a step applying a rule whose governing decision was retired), which is a skill-judgment case and not a
platform one. So this ruling ratifies the corpus's existing lean rather than re-cutting it.

### 4. Milestone #44's completion condition is confirmed, not changed

"The #4637-B bar green at 1.0 scope" means 1.0 over the corpus admissible under §1. The class this ADR
rules out was never executable, so excluding it neither widens nor narrows the campaign's closing
condition — it makes explicit which corpus the condition was always about.

**Binding constraints.**
- A case whose failing behaviour is only observable by watching platform mechanics is declined, with the
  reason recorded, and routed to a CI guard or regression test — a different artifact and a different
  ticket.
- A platform-originated incident may not be admitted as a graded case. If it cannot be worded
  mechanically, it is out.
- Route a declined incident; never drop it silently (the corpus README's `declined` path).

**Banned.**
- Taking, or dropping, the harness/platform bucket wholesale on its existing labels.
- Treating a `graded` derived tier on a platform-originated case as a tier choice rather than a
  rejection.

## Deviations

**One, named rather than resolved by assertion.** The two rulings overlap on everything except the edge
of the response class. The founder ruling admits *an agent's response* to a platform failure as in
scope, and two of its three worked examples — #3954's improvised-and-diverging workarounds, #4110's
hand-discharged guards — read as judgment, which is the graded axis's material. The later delegated
ruling admits a case only when the failing behaviour is observable in a produced artifact and confines
it to the deterministic tier. Where a response is real judgment but left no run-produced trace, the
first ruling admits it and the second does not.

This record follows the **later, narrower** delegated ruling, because it is the one that answers #4824's
own acceptance criteria and it is the one that keeps the ruled bar's variance argument intact — a
judgment case with no artifact to read is exactly the graded-axis noise the founder ruling's cost
argument objects to. That is a composition, not an override, and the founder's veto on the 2026-08-09
delegated ruling remains open: if the veto lands, §1's tier confinement is what changes, and §2's
"write the case about the response" is unaffected either way. This ADR does not claim the seam is
settled; it claims it is visible.

Nothing else here deviates from either ruling.

## Consequences

A case author gets one sentence to apply per row and no bucket to re-derive. The `~22 items` candidate
stays a candidate, and the split the founder ruling made owed is done incrementally, at authoring time,
against the rule — which is where the judgment is cheapest.

The corpus loses a class of real, well-documented incidents. That is the intended trade: they remain
incident records and they remain worth a regression test on the tool, but they leave the graded axis so
the number it produces keeps meaning "did the skill make the right call." A bar that moves for reasons
the skill does not control stops being believed, and a gate nobody believes is decorative.

The rule's edge is genuinely judgment-y on some rows — "is this trace an artifact a run produced?" will
be arguable. `deriveTier` decides the tier half mechanically, but whether an incident is *about* a
response or *about* a breakage is still a reading. The residue in §Deviations is the sharpest instance,
and it is the most likely thing in this record to move.

## Records

- Closes [#4824](https://github.com/kamp-us/phoenix/issues/4824). Answers
  [#4634](https://github.com/kamp-us/phoenix/issues/4634) calibration flag 6, which
  [#4642](https://github.com/kamp-us/phoenix/issues/4642) left silent. Scoped by
  [#4823](https://github.com/kamp-us/phoenix/issues/4823)'s enumeration.
- The consumer-facing copy of §1 lands in the same PR, appended to
  `packages/fabrika-cli/src/eval/incident-corpus/README.md`'s "What makes an incident a case", which is
  where a case author reads.
- **No vocabulary impact.** This decides scope and tier placement over already-named concepts
  (`deterministic tier`, `graded axis`, `incident corpus`); it coins and redefines nothing.
