---
id: 0371
title: An architecture audit files only the findings a human picked, never everything it found
status: accepted
date: 2026-09-10
tags: [pipeline, fabrika, architecture-audit, intake]
---

# 0371 — An architecture audit files only the findings a human picked, never everything it found

**What this decides:** the audit skill hands back a ranked table and stops; a human says which rows
become issues, and only those are filed.

## Context

ADR [0099](0099-glossary-surface-audit-skill-emits-issues.md) settled that an architecture audit's
output is triageable issues rather than a document, and it settled the auto-filing half in the same
breath: one issue per consolidated, deduped finding, filed without anyone in the loop. That skill
retired with the `kampus-pipeline` plugin (ADR
[0303](0303-retire-kampus-pipeline-plugin.md)), and 0099 already carries a dated line saying so and
saying Decision 1 still governs if the skill is ever re-authored.

It is being re-authored now ([#8808](https://github.com/kamp-us/phoenix/issues/8808)), and the
auto-filing half has a measurement against it. The one recorded run of the retired skill — 2026-07-04,
18 modules — filed 30 findings, of which the founder kept 10. Twenty issues arrived on the board with
a `status:needs-triage` label, took a triage pass each, and were closed. That cost is not a triage
failure: it is what an ungated audit is, because the audit has no oracle and files its candidates.
Auto-filing therefore makes the audit *more* expensive the better it is at noticing things, which is
the wrong incentive on a tool whose whole job is noticing things.

The alternative was ruled on the grilling session this skill graduated from
([#8806](https://github.com/kamp-us/phoenix/issues/8806), ruling R1.1): return the ranked table,
file the picked set. Nothing about the *shape* of a filed finding changes — it is still one issue per
distinct problem, still type-blind, still `status:needs-triage`, still through `report`'s own path.

This is platform/infra, so engineering leads the call (ADR
[0078](0078-product-driven-decisions-by-default.md)).

## Decision

**The `architecture-audit` skill files nothing on its own authority: it returns a ranked finding
table to a human, and only the rows that human picks are filed.**

The mechanics:

- The skill's terminal step in the audit half is the table — one row per consolidated finding, with
  its rank, smell, severity, location, deepening direction, lens attribution, the open issue it
  duplicates if any, and the skill's own recommendation. The recommendation is a recommendation.
- Filing runs after the pick, over the picked rows only, through `fabrika report dedup` and then
  `fabrika report file`. A picked row that duplicates an open issue goes on that issue through
  `fabrika report note` instead of becoming a twin.
- Silence is not approval. The skill does not file the rows it would have picked, does not file the
  unambiguous ones early, and does not carry unpicked rows into a later session.

**This amends ADR 0099 in part and supersedes nothing.** 0099's Decision 1 has two halves, and only
one moves:

| 0099's half | State |
|---|---|
| The output is triageable issues, one per consolidated finding — never an audit document | **Unchanged.** A finding becomes an issue or it becomes nothing. |
| Every finding is filed automatically, with nobody in the loop | **Replaced** by the pick above. |

0099's Decisions 2 and 3 — `.glossary/` as a committed doc surface, and the two skills joining the
suite — are untouched.

**Binding constraints.**

- No unattended mode files an audit finding. An automated shape is a later decision, and it needs a
  record of what a human actually keeps before it can be argued for.
- The gate binds the audit skill, not `report`. A `report` run stays what it is: a capture with no
  permission step, because capturing costs almost nothing and proposing first is what kills an
  observation.
- A filed audit finding stays type-blind and priority-blind. The pick decides *whether* a finding is
  filed and never *what* it is; classifying remains triage's.

## Consequences

- **The backlog carries what a human chose to carry.** On the one measurement available, that is ten
  issues rather than thirty, and the twenty triage passes are not spent.
- **The audit can be run more freely.** An ungated audit is expensive to run speculatively, because
  every run costs the board. A gated one costs a reading, so "let's audit that folder" stops being a
  decision with a backlog consequence attached.
- **A finding can be lost to inattention.** The table dies with the run, by design — there is no
  parked set and no follow-up queue. A human who skims the table loses what they skimmed, which is
  a real cost the auto-filing shape did not have. It is accepted: a lost candidate is cheaper than
  twenty triaged closures, and the audit is re-runnable.
- **The skill cannot run unattended.** It cannot fork into a background subagent, because the table
  it returns is the thing a human is waiting on. That is recorded in the fabrika skill conventions'
  forking table rather than here.
- **Two records now govern one skill.** Anyone reading 0099 for the audit's output contract has to
  reach this one for the filing half; 0099's `status:` line carries the amend link, which is the
  only pointer that mechanism provides.

## Records

No vocabulary impact — no term is coined or redefined. "Finding", "coverage gate" and "deepening
opportunity" are the audit method's own words, defined in the skill's own `SMELLS.md` and
`DEEPENING.md`, and neither is a repo-wide noun the glossary registers own.
