---
id: 0469
title: A Deviations heading written at the wrong level is repaired automatically, never one whose text drifted
status: accepted
date: 2026-10-04
tags: [fabrika, cli, pipeline, wire-formats, build]
---

# 0469 — A Deviations heading written at the wrong level is repaired automatically, never one whose text drifted

**What this decides:** a pull request body that writes `### Deviations` where `## Deviations`
belongs gets fixed by the tool, the same way the Acceptance criteria heading already is.

## Context

A pull request body states its deviations under the exact heading `## Deviations`. The grammar
lives in [`packages/fabrika-cli/src/wire/deviations.ts`](../packages/fabrika-cli/src/wire/deviations.ts),
and ADR [0288](0288-producers-run-consumer-readers.md) has the verb that posts a body run that
reader first. A heading at the wrong level is refused there. `### Deviations` answers
`the deviations heading has drifted — heading level 3, expected 2` (`driftReason` in that file).
The refusal names the fix, and a person makes it by hand.

The Acceptance criteria heading has the same slip and an automatic fix for it.
[`packages/fabrika-cli/src/triage/repair-criteria.ts`](../packages/fabrika-cli/src/triage/repair-criteria.ts)
rewrites a heading whose text is already exact and whose only defect is the level. It refuses a
heading whose text drifted, because rewriting text cannot be told apart from inventing a contract.

An adopter report, [#10035](https://github.com/kamp-us/phoenix/issues/10035), pointed at the gap:
two neighbouring blocks, and only one has the repair. The founder answered it on the rulings desk on
2026-10-04
([ruling comment](https://github.com/kamp-us/phoenix/issues/10035#issuecomment-5983080227)). The
question, as the desk asked it:

> PR bodies use a level-2 heading for "Deviations" and a level-3 heading for "Acceptance criteria".
> Only the criteria heading has an automatic fix when someone writes the wrong level (#10035).
> Should "Deviations" get the same automatic fix?

He picked "Yes, add the fix". This record transcribes that answer, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It reverses no earlier record.

## Decision

**A Deviations heading whose text is exact and whose only defect is its level is repaired to
`## Deviations` automatically, with no hand edit.**

- **The fix is the one the criteria heading has.** It covers a level-only drift and nothing wider.
- **A heading whose text also drifted is still refused.** It is never rewritten.

**Not ruled.** The ruling answers the one question above. These stay open:

- Which verb carries the fix. The ruling names none, and the build settles it.
- The depth of either heading. The desk did not ask, so `## Deviations` and
  `### Acceptance criteria` stay as they are.
- Whether the fix reaches the Deviations section an epic child posts as an issue comment. The desk
  asked about pull request bodies.

**Binding constraints.**

- The repair never rewrites heading text.
- The repair never changes what the section says, only the level of its heading.

## Consequences

A wrong-level Deviations heading no longer costs a refused body and a hand edit, or a review round
when it slips through in a lane.

The two headings keep different depths, so the slip itself will keep happening. The repair absorbs
it.

The fix changes what a verb does with a body, so the build updates that verb's help and contract
with it.

## Records

The build work is [#10513](https://github.com/kamp-us/phoenix/issues/10513).

Sources: the ruling at
[#10035, comment 5983080227](https://github.com/kamp-us/phoenix/issues/10035#issuecomment-5983080227);
ADRs [0288](0288-producers-run-consumer-readers.md) and
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md);
[`packages/fabrika-cli/src/wire/deviations.ts`](../packages/fabrika-cli/src/wire/deviations.ts);
[`packages/fabrika-cli/src/triage/repair-criteria.ts`](../packages/fabrika-cli/src/triage/repair-criteria.ts).
