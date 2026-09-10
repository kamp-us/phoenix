---
id: 0380
title: plan-epic writes the epic's own acceptance criteria, and no verb grows an epic arm
status: accepted
date: 2026-09-10
tags: [fabrika, plan-epic, review, epic, acceptance-criteria]
---

# 0380 — plan-epic writes the epic's own acceptance criteria, and no verb grows an epic arm

**What this decides:** the `plan-epic` plan block gains an `### Acceptance criteria` section, so a
planned epic body carries the same gradeable surface every other issue kind carries and the epic
tail's review verbs work on it unchanged.

## Context

An epic tail PR links its epic with `fixes:`, and ADR
[0285](0285-epic-machine-ends-in-review.md) makes that one PR the epic's review. But a planned epic
body carried no acceptance-criteria block: `plan-epic` wrote `### Goal / non-goals` and a task
ledger, and each child held its own criteria. So on every epic tail,
`packages/fabrika-cli/src/review/criteria-verb.ts` read `Absent` through
`packages/fabrika-cli/src/wire/acceptance-criteria.ts` and refused on exit 7, and
`append-criterion` refused the same way — which closed ADR [0079](0079-reviewer-authored-acceptance-criteria.md)'s
append-only fence on exactly the reviews that most need it.

Two costs, both observed on PR #6313 (tail of epic #5631, 208 files). The grading subject for the
most expensive review in the pipeline was reconstructed by hand out of the plan's prose, so it
varied by reviewer and nothing pinned it. And three in-scope tail findings had nowhere sanctioned to
go, so they survived only as verdict prose the next round's reviewer is not obliged to read as a
contract.

Issue [#6419](https://github.com/kamp-us/phoenix/issues/6419) offered three shapes: grow an epic arm
on `review criteria`, emit the block from `plan-epic`, or grow a tail form on the append fence.

## Decision

The founder ruled option 2 on 2026-08-20 —
https://github.com/kamp-us/phoenix/issues/6419#issuecomment-5362243225.

`plan-epic` emits an `### Acceptance criteria` block on the epic body alongside the task ledger.
Every issue kind then carries the same gradeable surface, and `review criteria` / `review
append-criterion` work on an epic tail with no change at all. **No verb grows an epic arm** —
`criteria-verb.ts` and `append-criterion-verb.ts` are untouched.

Four things follow, and each is where the ruling lands in code:

1. **The section is part of the closed set.** `PLAN_SECTIONS` in
   `packages/fabrika-cli/src/ledger/plan-block.ts` carries `Acceptance criteria` between `Approach`
   and `Testing strategy`, so `ledger draft` refuses a plan that omits it, and refuses one whose
   section is prose rather than `- [ ] ` rows — read back through the same wire module every grader
   reads. A planner cannot stage a plan whose own criteria the tail reviewer will not be able to
   read. This extends ADR [0046](0046-plan-epic-prd-grade-plans.md)'s section set; that record's
   list is history, not the live one.

2. **They are authored on `ledger draft`'s stdin, not appended after `ledger write`.** That puts
   them ahead of the grilling and the founder plan approval of ADR
   [0289](0289-founder-approves-every-epic-plan.md), so the criteria are approved with the plan
   rather than slipped in beside it.

3. **The scope digest binds them.** `epicLine` in `packages/fabrika-cli/src/plan/digest.ts`
   serializes the criteria *texts*, so editing one after approval resolves the standing approval to
   `stale` in `packages/fabrika-cli/src/plan/approval.ts`. Texts and not a count, because a reworded
   criterion is a different contract and a count would not see it. The **checked state is excluded**,
   for the reason the flip labels are: ticking a box is not a re-scope.

4. **Epics planned before this drain as emitted** — the [#6683](https://github.com/kamp-us/phoenix/issues/6683)
   ruling. A tail reviewer on such an epic grades against the plan's `### Goal / non-goals` and says
   so in the verdict, until that epic is re-planned; `claude-plugins/fabrika/skills/review/SKILL.md`
   §2 carries that fallback.

## Consequences

**Nothing on the board goes stale on merge.** The digest's criteria component is appended *only when
the epic body carries a block*, so a pre-0380 epic serializes byte-for-byte as it did and its
standing founder approval stays `current`. Without that clause this change would have invalidated
every approval on the board on the day it landed, which is the drain-as-emitted clause pointing the
other way.

**No new `plan check` floor defect.** The ruling asked for none, and one would red every
already-planned epic the same clause protects. The floor is unchanged; the enforcement sits at
authoring time in `ledger draft`, where the plan is still cheap to fix.

**`plan read` does not print the criteria.** They are a digest input that is invisible in that
verb's output, which every other scope field is not. Deliberate: ADR
[0308](0308-bounded-evidence-output-shape.md) bounds what a verb prints as evidence, and criterion
prose is unbounded. The criteria are readable on the epic body itself — the artifact the founder
approves — so nothing is hidden from the reader who has to judge them.

**The `--type epic` criteria exemption in `packages/fabrika-cli/src/triage/apply-verb.ts` stays.**
An epic is stamped at triage *before* it is planned, so it still carries no block at stamp time; the
carve-out's reason is now that ordering rather than "criteria live on the children".
