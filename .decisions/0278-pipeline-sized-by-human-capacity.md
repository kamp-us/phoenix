---
id: 0278
title: The pipeline is sized by human capacity, never by agent output
status: accepted
date: 2026-08-15
tags: [process, pipeline, prioritization, review]
---

# 0278 — The pipeline is sized by human capacity, never by agent output

**What this decides:** Agents build, but humans still set the pace. The backlog keeps a coarse hierarchy plus an open lane for items with no parent, batches are sized to what a reviewer can actually check, and the founder's only recurring seat is the milestone and epic intent gate.

## Context

Three rulings from grilling session [#5561](https://github.com/kamp-us/phoenix/issues/5561), round 6, all given together on 2026-08-14 and recorded there as R6.1, R6.2 and R6.3. Each has an authorization comment on the session. The founder's answer, verbatim:

> yeah, i like your rec

It answered a message whose recommendation read, in full: "skip the reset, batch by review size, keep yourself at the milestone and epic intent gate only". Round 6 then split that one recommendation into three questions so each clause sits on the record separately. The question wording is the agent's; the ruling is his.

The three belong in one record because they are one answer to one question: once agents do the building, what stays scarce? Human attention. Structure it once, spend it on review, and spend it on intent.

### Evidence, with theory kept apart from measurement

Recorded on the same session as R4.1, R4.2 and R4.3.

Formal models, not measurements:

- Ethiraj and Levinthal, "Modularity and Innovation in Complex Systems," *Management Science* 50(2), 2004. A simulation over decompositions that are over- and under-modular against the true structure. The load-bearing result is the asymmetry: too much modularity can stop adaptation entirely, while too little only slows it and risks lock-in. Over-decomposing hurts more than under-decomposing. https://pubsonline.informs.org/doi/10.1287/mnsc.1030.0145
- Baldwin and Clark, *Design Rules, Vol. 1* (2000). Modularity is an option whose value must clear a fixed architecture cost. Splitting alone earns nothing.
- Reinertsen, *The Principles of Product Development Flow* (2009). Batch size is a U-curve of transaction cost against holding cost, and Little's Law puts wait time at queue size over processing rate. Analytical and practitioner, not measured. It is why a work-in-progress cap belongs at the slowest server.

Measured:

- Kulk and Verhoef, "Quantifying requirements volatility effects," *Science of Computer Programming* 72 (2008), over 84 projects. Requirements churn runs near 2% a month. Reading that rate as the decay rate of a hierarchy invented before the dependency structure is known is inference, not a result of the paper.
- The Cisco and SmartBear review study (2005-06; 2,500 reviews, 3.2M lines, 50 developers). Defect detection falls off past roughly 200 to 400 lines per review. An industrial case study, not a controlled experiment. https://static0.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf
- Faros AI (2025), telemetry from 1,255 teams. High-adoption teams merge 98% more pull requests while review time rises 91% and pull request size rises 154%, with weak organisation-level gains. Vendor telemetry, no causal identification. https://www.faros.ai/blog/ai-software-engineering
- Duma and colleagues (2026) over the AIDev dataset of 932,000 pull requests. 61.4% of AI-authored pull requests get no recorded review, and human-only review falls from 25.2% on human pull requests to 8.1% on agent ones. https://arxiv.org/html/2605.02273v1

Null result, stated rather than papered over: no empirical study was found testing whether forcing every work item to have a parent changes throughput or prioritization quality. What exists is vendor documentation asserting benefits with no data. Clause 1 therefore rests on the two findings above plus the practical fact that bugs and chores arrive unparented every week, not on evidence that forced parenthood fails.

### What this relates to

- **ADR [0083](0083-agents-deploy-humans-release.md)** already ruled the other end of the same pipeline: the merge-time human eyeball is gone, green PRs auto-ship, and the human checkpoint moved to the release flip. That is the output side. Clause 3 is the input side, and the two together say where the human's remaining seats are: intent going in, release coming out, nothing per-PR in between outside the control-plane paths. 0083 is untouched.
- **ADRs [0053](0053-control-plane-boundary.md) / [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)** keep one human seat in the per-PR path, and this record leaves it exactly where it is. A pull request that touches a control-plane path is held at the enqueue seam until a `@kamp-us/control-plane` member approves it at the current head. That is a path-scoped authorization seat: it fires on which files changed, not on every issue, and no clause here is a standing per-issue review seat. ADR [0274](0274-fabrika-tree-is-not-control-plane.md) re-affirmed it four days ago. Clause 3 and the ban on a per-issue review seat are about ordinary work, and neither reaches this gate.
- **ADRs [0202](0202-forward-motion-doctrine-crewops.md) / [0208](0208-standing-lane-exemption-from-full-homing.md)** rule *milestone homing*: every open issue is homed or killed, with two standing lanes exempt. That is a different axis from *parenting*. Clause 1 is about the parent-issue rollup only. Milestone homing is unchanged, and an unparented issue still takes a milestone or a standing-lane label.
- **ADR [0210](0210-direction-binds-at-intake.md)** already put the founder's seat at intake: the pitch, the appetite, the betting call, and no merge-time direction gate. Clause 3 names which intake seat that is, milestone and epic intent, and clause 2 does not loosen it. Unparented is not unpitched either: a parentless feature still needs an approved pitch under 0210 before it enters the drain.
- **The flat build-lane work-in-progress budget** (6 lanes, 2 reserved for platform; #3227, see `platform lane` in [`.glossary/TERMS.md`](../.glossary/TERMS.md)) already caps concurrency. Clause 2 does not change the number. It fixes where the number comes from: review throughput, not agent throughput.

Nothing is superseded.

## Decision

**Human capacity is the pipeline's binding constraint, so it sizes the batches, the lanes and the hierarchy; agent output sizes none of them.**

**1. No top-down backlog reset (R6.1).** The backlog keeps a coarse hierarchy plus an explicit lane for items with no parent. Work is not all forced under a parent. Small unparented items are batched into runs that share a review context, meaning one reviewer pass and one CI run. The reset stays available later as optional cleanup, never as a prerequisite for anything.

**2. Batches are sized by review capacity (R6.2).** A batch is sized to what a reviewer can actually check, and work in progress is capped at review throughput, not agent throughput. Lanes opened beyond the review rate add queue, not output. Automated verification runs ahead of the human, because every defect that reaches the scarce server costs it twice, once in review and once in rework.

**3. The human sits at the milestone and epic intent gate only (R6.3).** Per-issue verification stays machine-executable. Where a check cannot be written as a machine gate, it belongs at the intent gate or nowhere.

**Binding constraints.**

- No sweep, skill or agent may require a parent for an issue to be workable.
- A batch is sized against the reviewer's window, and concurrency is set from review throughput.
- Per-issue acceptance criteria are machine-executable. A criterion that needs a human eye is an intent-gate concern, not an issue-level one.
- Changing any of the three needs a founder ruling, not a skill edit.

**Banned.**

- A forced-parenthood rule for the backlog.
- Sizing a batch or a lane count from what agents can produce.
- A standing per-issue human review seat reintroduced by any gate.

## Consequences

- Rollup reporting gets harder and priority stays partly incomparable, since an unparented p1 competes against nothing. Accepted.
- Agent capacity is deliberately left idle when review is saturated. That will look like underuse. It is not: the lanes beyond the review rate were producing queue.
- The risk this design runs is exactly the Duma finding. When most agent-authored pull requests get no human review, the gates are the only thing standing between a defect and `main` on ordinary pull requests. This ADR takes that trade knowingly. The failure mode to watch is gates that are weaker than believed, and the way to watch it is to instrument gate escapes, not to add an eyeball back.
- The hierarchy stays cheap to change, which matters at a 2% monthly churn rate.

## Records

Vocabulary: **unparented lane** is coined here and added to [`.glossary/TERMS.md`](../.glossary/TERMS.md) in this pull request.
