---
id: 0326
title: The last conforming acceptance-criteria block is the contract, and a near-miss below it refuses
status: accepted
date: 2026-08-21
tags: [fabrika, pipeline, cli, contracts, wire-formats]
---

# 0326 — The last conforming acceptance-criteria block is the contract, and a near-miss below it refuses

**What this decides:** When an issue body carries more than one acceptance-criteria block — the
shape amend-never-rewrite produces every time an issue is re-scoped — the last correctly spelled
one is what a gate grades against, and a heading that reaches for the block but misses is refused
out loud instead of being dropped in silence.

## Context

Every grader in the pipeline reads the acceptance-criteria block through one module,
[`packages/fabrika-cli/src/wire/acceptance-criteria.ts`](../packages/fabrika-cli/src/wire/acceptance-criteria.ts):
`review criteria`, `build issue`, `build claim`'s criteria axis, `triage apply --ready-for agent`,
the scope-admission fence and the plan loader among them — fourteen non-test modules bind it today.
ADR [0241](0241-wire-formats-owned-by-schema-modules.md)
is why there is exactly one of them, and why its read is total — `Found`, `Absent` or `Malformed`,
never a plausible empty answer.

That reader collects every heading that *reaches for* the block (normalising to contain `acceptance`
or `criteri`, or landing within three edits of the key), then keeps the ones spelled exactly
`### Acceptance criteria`. Two of its branches were wrong for an amended body:

- **Two conforming blocks** answered `Malformed` — "which one is the contract is undecidable". The
  issue became ungateable, and `triage repair-criteria` could not rescue it: that module repairs
  heading level and bullet-to-checkbox shape, and refuses drifted heading *text* on purpose.
- **One conforming block plus a later near-miss** served the conforming one and dropped the
  near-miss without a word.

Issue [#6693](https://github.com/kamp-us/phoenix/issues/6693) hit the second branch. Its body carried
`### Acceptance criteria` (8 items), then a `## Re-scope after #6690` amendment whose
`### Revised acceptance criteria` block carried 6. The reader served the superseded eight and
signalled nothing, so PR [#6816](https://github.com/kamp-us/phoenix/pull/6816) was graded against a
contract the amendment had already struck and failed rows nobody was still asking for.

The pinch is that this repo's convention is amend-never-rewrite: GitHub keeps no issue-body history,
so a re-scope appends a dated amendment and never overwrites the original. An amended issue
therefore carries two criteria blocks **by design**, and until this ADR both spellings of that shape
were broken in opposite directions — the conforming spelling wedged the issue, the near-miss
spelling graded it stale. No spelling of an amended body graded correctly.

Blast radius was measured before the choice landed rather than guessed at
([the count, on #6822](https://github.com/kamp-us/phoenix/issues/6822#issuecomment-5368423875)): of
284 open issues, 177 carry a candidate heading, and **zero** carry either multi-block shape. Two
carry a drifted heading and no conforming block, which this ADR does not touch — they read
`Malformed` before and after. So the rule regrades nothing currently open. It is worth landing
because the shape recurs by convention, not because a backlog of stale grades is waiting.

Three named alternatives were rejected, and each is recorded here because the next reader of this
module will reach for one of them:

- **Serve every block, headed, and let the caller decide.** Rejected: it widens the read's answer
  type, so every consumer of the module grows a branch — and the one that forgets is silently back
  to the defect this ADR closes.
- **A pinned supersede marker on the amendment naming the block it replaces.** An explicit answer in
  the register of ADR 0241, and more grammar than "last wins" needs today. Rejected for now;
  revisit if last-wins is ever caught misgrading a real body.
- **Refuse on any second candidate.** Rejected on the same ground the first branch was: it wedges
  every amended issue with no automated repair route, in a repo whose convention produces amended
  issues on purpose.

The ruling this ADR transcribes is the founder's, recorded at
[#6822 (comment)](https://github.com/kamp-us/phoenix/issues/6822#issuecomment-5365031897).

## Decision

**The last conforming `### Acceptance criteria` block in a body is the contract; a candidate heading
that misses that spelling and sits *below* the served block is `Malformed`, never dropped.**

The reader's rules, in the order it applies them:

1. **No candidate heading at all** → `Absent`. Unchanged.
2. **Candidates, none conforming** → `Malformed`, naming the drift. Unchanged.
3. **Two or more conforming blocks** → serve the **last**. An amendment supersedes what it was
   appended below. The "undecidable" refusal is retired.
4. **A non-conforming candidate below the served block** → `Malformed`, naming that heading and its
   line. Silent staleness is the defect #6822 filed; refusing is the fix.
5. **A non-conforming candidate above the served block** → dropped, as today. The conforming block
   below it already supersedes it, so there is nothing for a reader to be wrong about.

**An amendment that re-scopes an issue re-posts the whole revised list under the exact heading
`### Acceptance criteria`, below the original, in the body's contract region.** Three things follow
from that sentence and none of them is optional:

- The heading is spelled exactly, at level three. `### Revised acceptance criteria` is now a
  `Malformed`, and its repair route is to re-post the block under the conforming heading.
- The revised list is **whole**, not a delta. Rule 3 serves it alone, so a criterion the amendment
  still wants is a criterion the amendment restates.
- It lives in the body's contract region, not inside a `<details>` block. The reader skips a
  collapsed appendix by design, so an amendment folded into one is invisible to every gate.

The original block stays where it is, for the record. That is what amend-never-rewrite is for, and
rule 3 is what makes leaving it there safe.

**Binding constraints.**

- The rule lives in the one reader module and its unit tests. No consumer of it grows a
  block-selection branch of its own; a second selection rule is a second contract (ADR 0241).
- `triage repair-criteria`'s scope is unchanged. It repairs mechanical drift, and re-posting an
  amendment's block is an editorial act a human or `triage` performs on the body.
- Nothing here widens the read's answer type. It stays `Found` / `Absent` / `Malformed`.

## Consequences

- Amend-never-rewrite and the criteria contract stop contradicting each other. A re-scoped issue has
  exactly one correct shape, and it is the shape the convention already asks for.
- The failure mode moves from silent to loud. A near-miss below the served block now wedges the
  issue until someone fixes the heading, which is the trade this ADR is buying: a wedged issue is
  visible, a stale grade is not.
- An already-filed body that relied on the first block being served would now grade against the
  last. The measurement above says no open issue is in that position, so the migration cost is zero
  today and the risk is confined to bodies filed before someone reads this rule.
- The two-conforming refusal is gone, so a body that was ungateable becomes gateable. Anything that
  treated that `Malformed` as a signal — nothing does today — would need to look elsewhere.
- Implementation is not this ADR. It lands as a change to the reader plus the unit tests that pin
  each of the five rules, tracked separately.

## Records

No vocabulary impact. The terms used here — candidate heading, conforming, `Found` / `Absent` /
`Malformed` — are the reader module's own, already defined in code and in ADR 0241.
