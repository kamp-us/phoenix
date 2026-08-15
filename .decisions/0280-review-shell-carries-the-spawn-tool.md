---
id: 0280
title: The review agent shell carries the spawn tool; the driver plans no governance stage
status: accepted
date: 2026-08-14
tags: [pipeline, fabrika, governance, review, agents]
---

# 0280 — The review agent shell carries the spawn tool; the driver plans no governance stage

**What this decides:** when an automated run needs a `governance` verdict on a PR, the review agent
fires `governance` itself. The review shell is given an agent-spawn tool so it can. The thing driving
the run does not look at the PR and insert a governance step of its own.

## Context

Spike [#5554](https://github.com/kamp-us/phoenix/issues/5554) drove build, review and ship over the
fabrika skills for one real ticket, and stalled at the gate. Its review stage ran on a throwaway agent
that carried `Read, Edit, Write, Bash, Grep, Glob` and no agent-spawn tool. The PR it reviewed touched
`claude-plugins/fabrika/skills/prototyping/contract.md`, so the diff derived the `governance`
namespace, and `fabrika ship gate 5556` returned `gate blocked at this head` over three reasons:

```
- ns review-code fail (marker)
- ns review-skill fail (marker)
- ns governance absent
```

The two `fail` markers were the spike's own review verdicts and a repair could have cleared them.
`ns governance absent` was the one no repair could clear — a namespace nothing in the review stage
could fill. The stage did not misbehave; it was run in a shell that could not do what its own
contract tells it to do.

The contract had already picked the shape. `claude-plugins/fabrika/skills/review/SKILL.md` §6 says
that on `harness: true` the governance namespace is derived-required: fire the `governance` skill and
wait, and never emit that namespace yourself. Only the capability was missing.

Two candidate shapes went to the founder on
[#5558](https://github.com/kamp-us/phoenix/issues/5558): (a) the thing driving the run derives the
requirement from `fabrika governance scope <pr>` after build and before review, and plans a
conditional governance stage; (b) the review shell holds an agent-spawn tool so it can fire
`governance` and wait, as its contract already instructs. The driver half had no owner —
sibling epic [#5570](https://github.com/kamp-us/phoenix/issues/5570) is parked. The shell half has
one: [#5586](https://github.com/kamp-us/phoenix/issues/5586) already builds the three fabrika agent
shells and already requires each to declare an explicit scoped tool set.

This is also what makes ADR [0274](0274-fabrika-tree-is-not-control-plane.md) reachable. That ADR
takes the human approval gate off `claude-plugins/fabrika/**` and substitutes a required `governance`
verdict. A required verdict that no automated run can produce is not a substitute for anything, so the
review stage must be able to obtain one from inside the run. This decision is that ability.

## Decision

**The `review` agent shell carries an agent-spawn tool, so review fires `governance` itself and waits;
the run's driver plans no conditional governance stage.**

The grant is a tool, not a behavior. Review's obligation to fire governance, and its ban on emitting
that namespace itself, stay written in `claude-plugins/fabrika/skills/review/SKILL.md`. The shell
gains only the ability to obey what the skill already says, which is why the thin-shell rule of
[#5586](https://github.com/kamp-us/phoenix/issues/5586) still holds: no judgement moves into the
shell.

The trade was stated at ruling time and accepted: a spawn tool widens what the review shell can reach.
It is accepted, not an open risk. The containment is that the widening is a tool grant with no
matching instruction — the shell's text still carries no pipeline step, no rubric, no opinion.

**Binding constraints.**
- The `review` shell declares an agent-spawn tool in its scoped tool set, written into the definition
  as part of [#5586](https://github.com/kamp-us/phoenix/issues/5586).
- `fabrika governance scope <pr>` is the only sanctioned derivation of "is governance required".
- `governance scope` exit 11 means UNKNOWN, and UNKNOWN reads as REQUIRED.

**Banned.**
- A driver that branches on its own governance derivation to plan a conditional governance stage.
- Any shell or driver reimplementing path globbing to guess whether governance is required.
- Treating a failed or unreadable `governance scope` run as "not required".
- Moving any part of review's governance obligation out of `SKILL.md` and into the shell's text.

## Consequences

All of these are derived by agent from the verb contracts, not ruled. The only founder ruling is the
Decision above, verbatim in `## Records`.

1. **(Derived.)** The grant lands in the `review` shell definition under
   [#5586](https://github.com/kamp-us/phoenix/issues/5586), by design, rather than being discovered
   later by a lane that dead-ends at `governance absent` the way #5554 did.
2. **(Derived.)** `fabrika governance scope <pr>` stays the named derivation. Its own help text —
   [`packages/fabrika-cli/src/governance/command.ts`](../packages/fabrika-cli/src/governance/command.ts)
   — describes it as deriving whether a PR's diff requires the governance namespace, over which
   harness root, at the bound head. Nothing else may answer that question.
3. **(Derived.)** `governance scope` exit 11 is UNKNOWN, never not-required; the verb's help says so
   in those words. An unreadable derivation reads as REQUIRED, per the fail-closed law of ADR
   [0092](0092-gates-fail-closed-on-zero-scope.md). Reading UNKNOWN as "skip governance" is exactly
   the silent-green failure this repo keeps filing.
4. **(Derived.)** Review's wall-clock cost grows: it now waits on a nested governance run on
   harness-touching diffs. That cost was already implied by the contract; the shell only makes it
   real.

## Records

- Records the founder ruling of 2026-08-14 on
  [#5558](https://github.com/kamp-us/phoenix/issues/5558), verbatim: *"yeah, review shell carries the
  spawn tool"*.
- Implementation rides [#5586](https://github.com/kamp-us/phoenix/issues/5586) (the three fabrika
  agent shells); the alternative shape's owner,
  [#5570](https://github.com/kamp-us/phoenix/issues/5570), is parked and stays parked as far as
  governance routing is concerned.
- No vocabulary impact. This decides which shell holds a tool, over concepts already named — the
  `governance` skill and the `review` skill both carry rows in
  [`.glossary/TERMS.md`](../.glossary/TERMS.md), and what an agent shell is is defined by
  [#5586](https://github.com/kamp-us/phoenix/issues/5586)'s shell doc, not coined here.
