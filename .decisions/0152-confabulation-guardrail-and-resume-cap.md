---
id: 0152
title: A long-resumed gate subagent that confabulates verification-provenance is guarded by BOTH a verification-provenance discipline (general agent contract — un-run falsifiable claims MUST be surfaced as *unverified*) AND a single-subagent resume-cap (orchestration hygiene, distinct from #1751's crash-resume classification)
status: accepted
date: 2026-07-04
tags: [pipeline, triage, orchestration, integrity, agents]
---

# 0152 — Confabulation guardrail (verification-provenance discipline) + single-subagent resume cap

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

- **No pipeline-agent contract carries a bounded verification-of-platform-state rule.** There
  is no rule that a falsifiable platform-state claim (or an action-attribution) must be
  *run-in-transcript before it may be asserted as verified* — so there was nothing for the
  triager to violate. The CLAUDE.md grounding discipline is worded as *the reader's*
  re-grounding duty, not as *the emitter's* provenance obligation; the emitter's side was
  implicit.
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

Adopt **both** mitigations; each has a distinct home. **The founder ruling fixes those homes
here — they are not re-litigated per follow-up.**

**Mitigation (a) — verification-provenance discipline (general agent contract).** An agent
that runs a pipeline gate — the `triager` first, and every gate agent by extension — **MUST
NOT assert a falsifiable platform-state claim or an action-attribution as *verified* unless it
ran the check itself, in its own transcript, this run.** Any un-run such claim must be
surfaced as **unverified** (or dropped), and an action must never be attributed to another
party (the orchestrator, a sibling agent) that the emitter did not observe that party perform.
This is the **emitter-side complement** of CLAUDE.md's existing reader-side "ground falsifiable
platform claims in source, not intuition" rule: the reader re-grounds; the emitter must not
launder an un-run claim as verified in the first place.

Its home is the **general agent contract**, not a single skill's SKILL.md: it lands as a rule
in the pipeline **agent contract** — `claude-plugins/kampus-pipeline/agents/triager.md` — and
in the shared, all-gates **formats contract**
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`, so every gate agent
inherits it. **It is deliberately NOT scoped to the `triage` SKILL.md**: the confabulation
risk is a property of any long-resumed gate agent, not of the triage skill specifically, so
scoping the rule to one skill's prose would under-fix the demonstrated hole. The general rule
is the point. Because this rule lands on the pipeline agent contract + the shared gate-critical
formats contract (both control-plane surfaces), **mitigation (a)'s implementation is §CP** —
control-plane → human-merge, cansirin @head per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md). It is **not**
auto-shipped.

**Mitigation (b) — single-subagent resume cap (orchestration hygiene).** A single subagent is
**not resumed indefinitely**: past a bounded number of resume cycles the orchestrator
**spawns a fresh instance** rather than resuming the degraded one, because confabulation
correlates with very long resume chains. Its home is the **orchestrator** —
`.claude/workflows/drive-issue.js` — where the spawn/resume decision is made. This is an
**orchestration/harness-hygiene** rule, **distinct from #1751's crash-resume classification** —
#1751 decides *whether* to resume a **crashed** run (TRANSIENT vs LOGIC, K=2); this cap bounds
*how many times* a **healthy, non-crashing** subagent may be resumed before it is replaced. The
two compose without overlap: #1751 governs the crash axis (TRANSIENT/LOGIC, K=2), this governs
the **lifetime-degradation axis**. Because it lands in the orchestrator under `.claude/**`,
**mitigation (b)'s implementation is §CP** — control-plane → human-merge (cansirin @head per
ADR 0135), not auto-shipped. The exact cap value is an implementation detail for the follow-up;
the enforcement home (the orchestrator) is fixed here.

**This ADR records the decision; it does not itself implement.** The buildable changes are
filed as follow-up issues so each re-enters the pipeline and is built on its own merits:
**#2052** lands mitigation (a) (the agent-contract + formats-contract prose), and **#2053**
lands mitigation (b) (the resume-cap in the orchestrator). **Both #2052 and #2053 are §CP and
human-merged** — they touch the pipeline agent contract, the shared gate-critical formats
contract, and the orchestrator, so neither auto-ships; each is code-owner-approved and merged
by a human (cansirin @head per ADR 0135). **Both are freeze-exempt hardening of a demonstrated
hole** (the #1876 near-miss), not new feature scope, so they proceed through a delivery freeze.

## Consequences

- **Emitter-side provenance is now a stated obligation, not just a reader-side backstop.** A
  triager (and any gate agent) that has not run a falsifiable platform check may no longer
  present its conclusion as verified — it labels it *unverified* or omits it. This closes the
  "confabulated chain that happens to be right" trap at the source, not only at the
  re-grounding reader.
- **The fix is a general agent-contract rule, not a per-skill patch.** Because mitigation (a)
  lives on the general agent contract (`agents/triager.md` + `gh-issue-intake-formats.md`), the
  discipline binds every gate agent, present and future — no gate agent is left un-covered by
  virtue of not being the triage skill.
- **Action-attribution to an un-observed party is banned.** "Your evidence chain" / "the
  orchestrator ran X" is only assertable when the emitter observed that party do X; otherwise
  it is a fabrication even if X is true.
- **A degraded long-lived subagent is replaced, not trusted further.** Bounding resume cycles
  in the orchestrator removes the correlated confabulation risk without touching #1751's
  crash-resume policy — the two axes (crash-recovery, lifetime-degradation) are handled
  independently and are explicitly cross-referenced so they don't silently overlap.
- **Both implementations are §CP and human-merged.** Mitigation (a) (#2052, agent contract +
  formats contract) and mitigation (b) (#2053, orchestrator) each land on control-plane
  surfaces, so both are code-owner-approved and human-merged (cansirin @head per ADR 0135),
  never auto-shipped — and both are freeze-exempt hardening of the #1876 hole.
- **Cost:** a triager must now spend a transcript action to *actually run* any platform check
  it wants to cite as verified (or explicitly mark it unverified), and the orchestrator eats a
  fresh-spawn cold-start instead of a cheap resume once the cap is hit. Both are deliberate:
  the price of trustworthy gate output.
- **This ADR is a policy/routing decision over already-named concepts; it does not itself
  land the guardrails** — #2052 and #2053 do.

### Vocabulary impact

Names one term worth surfacing: **verification-provenance discipline** — the emitter-side rule
that a falsifiable platform-state claim or action-attribution may be asserted as *verified*
only if the emitter ran the check in its own transcript this run; otherwise it is surfaced as
*unverified*. It is the emitter-side complement of CLAUDE.md's reader-side grounding rule. This
is a lightweight coinage recorded here; if it earns a fuller `.glossary/TERMS.md` treatment
(disambiguation, cross-links) that is routed via #2052 (which lands mitigation (a)'s prose),
not this additive ADR PR.
