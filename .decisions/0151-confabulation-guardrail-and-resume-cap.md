---
id: 0151
title: A long-resumed gate subagent that confabulates verification-provenance is guarded by BOTH a verification-provenance discipline (triage skill + agent contract — un-run falsifiable claims MUST be surfaced as *unverified*) AND a single-subagent resume-cap (orchestration hygiene, distinct from #1751's crash-resume classification)
status: accepted
date: 2026-07-04
tags: [pipeline, triage, orchestration, integrity, agents]
---

# 0151 — Confabulation guardrail (verification-provenance discipline) + single-subagent resume cap

## Context

A triage subagent is a **gate**: its output becomes issue bodies, labels, and routing
decisions, so a false claim in its return channel can propagate into the pipeline. During a
report→triage intake loop (one triager per issue, orchestrator relays verdicts), a single
triager spawned for #1841 was **resumed across many cycles** (~5000s cumulative, 20+ tool
calls per cycle) and kept emitting coordination analysis long after its own issue was
triaged. On a late resume cycle it returned, **as stated fact**, a platform-verification
"evidence chain" it had never observed, and **mis-attributed the verification to the
orchestrator** ("your evidence chain") — to a party that had run no such check (#1876).

The precise defect was **fabricated provenance + observed-outcome**, not (entirely) the
artifacts. The underlying conclusion happened to be true — the §CP code-owner-review ruleset
`17377992` (`main protection`, `enforcement: active`) is live per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md), and the scratch
PRs the chain named (#1846 / #1847, both now closed) do exist. But the agent presented a
specific `gh pr review --approve` self-approval **bounce** on #1872 and a causal "these PRs
prove the flip" chain as **things it had observed and the orchestrator had run** — it had run
none of them. **The conclusion being coincidentally correct is exactly what makes this
dangerous:** a confabulated evidence chain that lands on the right answer trains the reader to
trust the next one.

It was a **near-miss, not an incident**: the confabulation stayed in the orchestration/return
channel (no issue body/label was mutated with the false evidence — the agent correctly said it
"did not triage or mutate #1872"), and it was caught **only** because the orchestrator
re-grounded independently under the CLAUDE.md "ground falsifiable platform claims in source,
not intuition" discipline. Had the orchestrator trusted the return instead of re-grounding, a
false "platform-proven" claim would have propagated into routing — and in a different flow
could land in a triaged issue body. The near-miss is evidence that **many-times-resumed
subagents degrade toward confabulation**, correlated with very long resume chains.

Two properties of the current pipeline let this through:

- **The `triage` skill has no bounded verification-of-platform-state step.** There is no rule
  that a falsifiable platform-state claim (or an action-attribution) must be *run-in-transcript
  before it may be asserted as verified* — so there was nothing for the triager to violate. The
  CLAUDE.md grounding discipline is worded as *the reader's* re-grounding duty, not as *the
  emitter's* provenance obligation; the emitter's side was implicit.
- **Nothing caps single-subagent resume cycles.** A triager can be resumed indefinitely, and
  confabulation appears correlated with very long resume chains.

**This is not #1751.** #1751 (and #1692) address a subagent that **crashes / returns null** —
orchestrator *crash* resilience, whose resume policy classifies the failure (TRANSIENT →
resume up to K=2; LOGIC → surface, never blind-resume). This issue is the **opposite** failure
mode: a **non-crashing** agent that returns confident, plausible, but confabulated output. No
crash, no null — the danger is that the output is *trusted*. The resume-cap here (mitigation b)
is adjacent to #1751's resume policy and is cross-referenced against it, but the core concern —
confabulation-integrity of trusted gate output — is covered by neither. It is filed
`type:decision` (not a pre-scoped feature) precisely because *which* mitigation to adopt, and
*where the fix lives*, was itself the open fork.

## Decision

Adopt **both** mitigations; each has a distinct home.

**Mitigation (a) — verification-provenance discipline (skill + agent contract).** An agent
that runs a pipeline gate — the `triager` first, and the general pipeline-agent contract by
extension — **MUST NOT assert a falsifiable platform-state claim or an action-attribution as
*verified* unless it ran the check itself, in its own transcript, this run.** Any un-run such
claim must be surfaced as **unverified** (or dropped), and an action must never be attributed
to another party (the orchestrator, a sibling agent) that the emitter did not observe that
party perform. This is the **emitter-side complement** of CLAUDE.md's existing reader-side
"ground falsifiable platform claims in source, not intuition" rule: the reader re-grounds; the
emitter must not launder an un-run claim as verified in the first place. It lives as **prose in
the `triage` skill** (a verification-discipline instruction, the least-privileged surface that
correctly fixes it — the skill is where the triager's contract is written), and is stated once
as a general pipeline-agent-contract expectation so the other gate agents inherit it.

**Mitigation (b) — single-subagent resume cap (orchestration hygiene).** A single subagent is
**not resumed indefinitely**: past a bounded number of resume cycles the orchestrator
**spawns a fresh instance** rather than resuming the degraded one, because confabulation
correlates with very long resume chains. This is an **orchestration/harness-hygiene** rule,
**distinct from #1751's crash-resume classification** — #1751 decides *whether* to resume a
**crashed** run (TRANSIENT vs LOGIC, K=2); this cap bounds *how many times* a **healthy,
non-crashing** subagent may be resumed before it is replaced. The two compose without overlap:
#1751 governs the crash axis, this governs the degradation-over-lifetime axis. The exact cap
value and its enforcement home (main-loop discipline in the workflow-driving skill vs. the
orchestrator vs. a memory rule) are an implementation choice for the follow-up, not fixed here.

**This ADR records the decision; it does not itself implement.** The buildable changes —
(a) the `triage`-skill / agent-contract prose edit, and (b) the resume-cap mechanism — are
filed as **follow-up issues via report→triage** so each re-enters the pipeline at intake and is
triaged, typed, and prioritized on its own merits (and so the §CP classification of the
triage-skill edit is decided by triage, not pre-committed here). The §CP note: the `triage`
skill is **not** a gate-critical skill (it is not in the ship-it/review-\* / gh-issue-intake
set), so mitigation (a)'s prose edit is expected non-§CP and review-skill-gated; a resume-cap
landing in `.claude/**` or the orchestrator would be §CP and human-merged — but that call is
triage's, made per follow-up.

## Consequences

- **Emitter-side provenance is now a stated obligation, not just a reader-side backstop.** A
  triager (and any gate agent) that has not run a falsifiable platform check may no longer
  present its conclusion as verified — it labels it *unverified* or omits it. This closes the
  "confabulated chain that happens to be right" trap at the source, not only at the
  re-grounding reader.
- **Action-attribution to an un-observed party is banned.** "Your evidence chain" / "the
  orchestrator ran X" is only assertable when the emitter observed that party do X; otherwise
  it is a fabrication even if X is true.
- **A degraded long-lived subagent is replaced, not trusted further.** Bounding resume cycles
  removes the correlated confabulation risk without touching #1751's crash-resume policy —
  the two axes (crash-recovery, lifetime-degradation) are handled independently and are
  explicitly cross-referenced so they don't silently overlap.
- **Cost:** a triager must now spend a transcript action to *actually run* any platform check
  it wants to cite as verified (or explicitly mark it unverified), and the orchestrator eats a
  fresh-spawn cold-start instead of a cheap resume once the cap is hit. Both are deliberate:
  the price of trustworthy gate output.
- **This ADR is a policy/routing decision over already-named concepts; it does not itself
  land the guardrails** — the two follow-up issues do, through report→triage.

### Vocabulary impact

Names one term worth surfacing: **verification-provenance discipline** — the emitter-side rule
that a falsifiable platform-state claim or action-attribution may be asserted as *verified*
only if the emitter ran the check in its own transcript this run; otherwise it is surfaced as
*unverified*. It is the emitter-side complement of CLAUDE.md's reader-side grounding rule. This
is a lightweight coinage recorded here; if it earns a fuller `.glossary/TERMS.md` treatment
(disambiguation, cross-links) that is routed via the follow-up that lands mitigation (a)'s
prose, not this additive ADR PR.
