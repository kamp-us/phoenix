---
id: 0245
title: A campaign-scope refusal binds at both fabrika seams, from one shared predicate, fabrika-only
status: accepted
date: 2026-08-09
tags: [fabrika, pipeline, roadmap, process]
---

# 0245 — A campaign-scope refusal binds at both fabrika seams, from one shared predicate, fabrika-only

**What this decides:** When we say "only the campaign in focus gets worked on," that refusal has to
live in two places to mean anything: the picker must not offer off-campaign work, and the claim step
must refuse an off-campaign issue handed to it directly. Both read the same one predicate, so they
can never disagree. It is built in fabrika only — the v1 picker cannot carry it — and until fabrika's
`build` verbs exist, nothing enforces it but people paying attention.

## Context

The focus ruling asks for one campaign at a time and everything else off the table. Epic work
([#5011](https://github.com/kamp-us/phoenix/issues/5011)) had to settle, before any refusal was
built, *where* such a refusal can bind with teeth and *which* pipeline it lands in. Several earlier
fences in this repo failed because they assumed the picker reads something it does not, so the
premise was re-verified from source rather than inherited.

**The v1 candidate pool, read from source
(`claude-plugins/kampus-pipeline/skills/write-code/scripts/step1-candidate-pool.sh`, read
2026-08-09).** The script loops the buckets `p0`, `p1`, `p2` and, per bucket, issues one REST call —
`repos/$REPO/issues?state=open&labels=status:triaged,$P&sort=created&direction=asc&per_page=100` —
then filters the response with `select(.assignee == null and (.pull_request | not))`. That is the
whole selection. Stated explicitly, because the negative is the load-bearing half:

- it selects on exactly four facts — **open**, **`status:triaged`**, **a bare priority label**
  (`p0`/`p1`/`p2`, tried in that order), and **a null assignee** — plus the not-a-pull-request
  exclusion;
- it reads **no milestone**, **no `## Dependencies` topology**, and **no `ready-for:` label**. None
  of the three appears anywhere in the script.

Milestone enters v1 only downstream of this pool, in
`claude-plugins/kampus-pipeline/skills/write-code/SKILL.md`, as a **within-bucket pick-order
tiebreaker** with priority sovereign — never as a filter, and never across buckets. So there is no
v1 surface where a scope fence could exclude anything without inventing one.

**The fabrika side already has the shape.** The derived `build` contract
(`claude-plugins/fabrika/skills/build/contract.md`) gives `build pick` a fail-closed label filter
that already carries this epic's sibling axis (`ready-for:agent` present, absence excludes) but no
scope axis, and gives `build claim` a comment-marker race on the issue. Dependency blockedness is a
*different* verb there — `build eligible`, derived from the parent ledger's `## Dependencies`
topology, never read off a label.

**Adjacent rulings this does not disturb.** ADR
[0219](0219-priority-decoupled-from-campaign-membership.md) decouples priority from campaign
membership — a home confers no band. This ADR is about **admission**, not banding: within admitted
work, priority ranks exactly as before, and being in focus still earns an issue nothing. ADR
[0072](0072-milestones-encode-strategic-sequencing.md) defines milestones as strategic sequencing
and keeps `p0` sovereign over any milestone lean; that governs v1 pick-order and is untouched here,
since nothing in this decision is built in v1.

Two more live rulings the contradiction sweep raised, resolved here on the record. ADR
[0210](0210-direction-binds-at-intake.md) binds direction at intake and **bans any merge-blocking
direction gate on a finished PR**; this fence is neither — it fires at pick and claim, before a build
starts, so no finished work is ever failed for direction. It adds a second binding point downstream
of intake on 0210's own principle (bind early, never at merge), and 0210 stands untouched. ADR
[0222](0222-p0-is-the-arc-pullable-frontier.md) defines the `p0` band as required-and-unblocked; that
is a triage-time judgment about a band, while `build eligible` derives blockedness at build time from
topology, and scope admission is a third, separate question. None of the three is the others.

Founder ruling, 2026-08-09, recorded on [#5011](https://github.com/kamp-us/phoenix/issues/5011) —
the conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)).

## Decision

**A campaign-scope refusal binds at both fabrika `build` seams — the pool filter and the claim
protocol — computed by one shared predicate; the whole thing is fabrika-only under ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md), and no v1 fence is built.**

**Both seams, because the pool filter alone has a hole.** `build pick` filtering off-campaign work
out of the offered pool is the ordinary path: an agent scanning the board is never shown work
outside focus. But an operator can hand an engine an issue number directly, and a directly-handed
number never passes through any pool. A filter that only runs on the browse path is advice, not a
fence. `build claim` therefore refuses an off-campaign number too, which is where the refusal
actually acquires teeth — claiming is the moment work starts, and it is the one moment every path
goes through.

**Neither seam is redundant.** Drop the claim refusal and the direct-handoff hole reopens. Drop the
pool filter and every off-campaign issue is still offered, so the refusal arrives after an agent has
already chosen, spent a read, and formed intent — a fence that only says no at the last step trains
people to route around it. They answer different questions (*what may I be offered* vs *what may I
start*) and both are needed.

**One predicate, two call sites.** Scope admission is computed in exactly one place
([#5015](https://github.com/kamp-us/phoenix/issues/5015)) and consumed by both seams
([#5016](https://github.com/kamp-us/phoenix/issues/5016)). Two implementations of the same question
would eventually disagree, and a board where the picker and the claim step hold different views of
what is in scope is worse than no fence at all.

**Fabrika-only.** ADR 0238 rules that fabrika re-implements v1's deterministic work and never calls
it, keeping v1 deletable. The v1 picker reads no milestone (proven above) and is scheduled to die at
release, so building a v1 fence would mean inventing a new selection axis inside the pipeline we are
retiring — paying for a surface that gets deleted, and buying a second authority on a question
fabrika must own.

**The refusal is overridable, explicitly and on the record.** A claim refusal can be overridden by
naming the override at the call, and the override is recorded. This is the "founder exception" as a
flag rather than as prose in a charter: the escape hatch exists, it costs one deliberate act, and it
leaves a trace. An **empty `## Focus` section admits everything** — declaring nothing in focus is the
off switch, not a board-wide freeze.

**Binding constraints.**
- Scope admission is computed in one place; `build pick` and `build claim` both consume that one
  answer.
- `build claim` refuses an off-campaign issue even when the number was handed to it directly.
- The override is explicit at the call site and recorded on the issue; a silent override is not one.
- An empty `## Focus` section admits every issue.
- Scope admission stays a distinct predicate from dependency eligibility (`build eligible`) — one
  answers *is this in the campaign*, the other *are this issue's predecessors done*. They are never
  merged into a single answer, never a single exit code, and a scope refusal never reads as blocked.
- Scope admission confers no priority and reorders nothing (ADR 0219 stands).

**Banned.**
- A campaign-scope fence in v1 — no new selection axis in `step1-candidate-pool.sh` or the v1
  write-code skill.
- A second implementation of the scope question anywhere.
- A pool-filter-only refusal shipped as if it were the fence.

## Consequences

**The interim gap is real and accepted.** The `build` verb group does not exist yet, and neither
does the wiring. Until [#5015](https://github.com/kamp-us/phoenix/issues/5015) and
[#5016](https://github.com/kamp-us/phoenix/issues/5016) land, **nothing mechanical enforces campaign
scope**: v1's picker cannot see it and fabrika's seams are not built. Enforcement in that window is
social — the focus declaration in `ROADMAP.md`
([#5012](https://github.com/kamp-us/phoenix/issues/5012)), crew charters, operator attention, and
per-instance exceptions. That is a weaker guarantee than a fence, it is stated rather than implied,
and the mitigation is to land the two build issues rather than to bridge the gap in v1.

**The declaration becomes load-bearing.** Once wired, a stale `## Focus` row silently stops work
that should be running. The section needs to be as cheap to edit as it is to read — editing the row
is a first-class way to unblock, alongside the explicit override.

**Refusals get chattier before they get quieter.** Early on, agents will hit scope refusals on work
that is genuinely fine, and each one costs an override or a row edit. That noise is the fence
proving it exists; it drops as the declaration settles.

**v1 stays deletable.** Nothing added here extends the old pipeline's surface, which is exactly what
ADR 0238 asks for.

## Records

Fixes [#5011](https://github.com/kamp-us/phoenix/issues/5011). The build-out is
[#5012](https://github.com/kamp-us/phoenix/issues/5012) (the `## Focus` declaration),
[#5013](https://github.com/kamp-us/phoenix/issues/5013) (the `build` contract amendment),
[#5015](https://github.com/kamp-us/phoenix/issues/5015) (the predicate + its verb) and
[#5016](https://github.com/kamp-us/phoenix/issues/5016) (wiring both seams).

Vocabulary impact: this ADR coins **scope admission** — the predicate deciding whether an issue is
inside the campaign in exclusive focus, and the refusal it drives at both `build` seams. It is not
priority (ADR 0219), not dependency eligibility (`build eligible`), not the milestone pick-order
tiebreaker (ADR 0072), and not the `ready-for:` audience axis. The term needs the fuller
"not …" treatment, so it is routed to
[`.glossary/TERMS.md`](../.glossary/TERMS.md) via
[#5069](https://github.com/kamp-us/phoenix/issues/5069) rather than added inline here.
