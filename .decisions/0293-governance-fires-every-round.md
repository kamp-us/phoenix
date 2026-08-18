---
id: 0293
title: Governance fires every review round on a governance-root diff, FAIL rounds included
status: accepted
date: 2026-08-18
tags: [fabrika, pipeline-hardening]
---

# 0293 — Governance fires every review round on a governance-root diff, FAIL rounds included

**What this decides:** on a `harness: true` diff the `governance` namespace is required at **every**
review round and at **every** head — a FAIL round owes a governance verdict exactly as a PASS round
does, and the namespace is re-fired after each repair push. `operate`'s all-namespaces-terminal
floor on the `FAIL` row stays as written.

## Context

Two fabrika rules could not both be satisfied on a `harness: true` PR whose review round returned
FAIL ([#6003](https://github.com/kamp-us/phoenix/issues/6003)).

`review`'s §6 stated the governance obligation on the PASS arm only — "your PASS with no governance
verdict on such a diff is not a complete gate result". A reviewer reading that arm as the whole rule
declined to fire governance on a FAIL round, reasoning that the repair moves the head so a verdict
bound to the current head is stale on arrival. It declined twice on lane 5718, same reasoning both
times.

`operate` records a reviewer `FAIL` only when every derived namespace holds a verdict that still
binds, governance included on a `harness: true` diff, and spawns no repair builder while any
namespace at the head is non-terminal. Its remedy for a missing namespace verdict is to re-read
until terminal — which cannot produce a verdict the reviewer structurally declined to write.

So the FAIL could not be recorded, the repair could not be dispatched, and governance would never
fire at that head. Lane 5718 / PR [#5993](https://github.com/kamp-us/phoenix/pull/5993) parked at
`blocked` with retries untouched at 0/2. Any `harness: true` PR whose first review round FAILs lands
in the same place. The machine side already agrees with the PASS half only:
[`packages/fabrika-cli/src/lane/prove-verb.ts`](../packages/fabrika-cli/src/lane/prove-verb.ts)
derives `governance` from `touchesGovernanceRoot` and reds at exit `23` on the PASS arm, while a
FAIL claims no artifact and so is proven by nothing.

## Decision

**Governance fires every round on a governance-root diff, FAIL rounds included, and re-fires per
repair head.** Ruled on #6003 (driver ruling comment
[5325005758](https://github.com/kamp-us/phoenix/issues/6003#issuecomment-5325005758), engineering-led
per ADR [0078](0078-product-driven-decisions-by-default.md)).

- For a FAIL round on a `harness: true` diff the governance namespace **is required**. The
  reviewer fires `governance` and waits, whatever polarity the code namespace reached. A FAIL with
  no governance verdict at that head is an incomplete gate result, the same way a PASS without one
  is.
- Neither namespace discharges the other. A current-head `review-code` FAIL does not excuse the
  governance read, and a governance verdict does not excuse the code read.
- Each repair head is a fresh round: governance is re-fired at the new head and the prior verdict
  is stale, never carried forward. Staleness is ADR [0276](0276-verdict-binds-content-not-only-head.md)'s test,
  not a stricter one — a repair changes the reviewed content, so its verdict goes stale; a head that
  moved without touching that content keeps the verdict 0276 says still binds.
- **`operate`'s all-namespaces-terminal floor on the `FAIL` row stays.** It keeps its ability to
  tell "the reviewer declined" from "the reviewer died mid-emit", because after this ruling nothing
  licenses a decline — a missing governance verdict on a `harness: true` FAIL round is always an
  unfinished read, and re-reading until terminal is now a remedy that can actually terminate.

**The rejected option:** scoping `operate`'s all-namespaces gate to the PASS arm, letting a FAIL
through on whatever namespaces did report. It was rejected because it loosens a fail-closed guard
and puts nothing in place of the distinction it drops: with the floor gone, a FAIL recorded over a
half-written verdict set is indistinguishable from one recorded over a licensed decline, and the
machine spends a retry either way.

**The accepted cost:** governance runs on rounds that may die in repair. A `harness: true` PR that
takes three repair rounds pays four governance runs, and each verdict but the last is discarded when
the head moves. That is the economy optimization the reviewer was making on its own authority; it
yields.

## Evidence

The ruling was exercised live on lane 5718 before being recorded, twice, and FAIL-round governance
caught two real defects the code namespace never would have. Both verdicts are FAILs at heads the
old reading would have left ungoverned.

1. **Undisclosed amendment of a live ADR** — governance FAIL at `7a2c2b5c`
   ([comment 5325089755](https://github.com/kamp-us/phoenix/pull/5993#issuecomment-5325089755)).
   The diff replaced the mechanism ADR [0239](0239-release-please-manifest-mode-version-derivation.md)
   records as binding ("the existing OIDC `pnpm publish` job on the release event is still the only
   thing that ships a tarball"), and recorded the replacement only in a workflow comment. Same
   verdict's second finding: the dispatched publish path resolved its tag as
   `github.event.release.tag_name || github.ref_name` with nothing testing the ref *type*, so a
   branch named `fabrika-cli-v9.9.9` matched the publish grammar and an unmerged, untagged tree
   could reach npm under OIDC — while the file's own header asserted the opposite guarantee.
2. **A required-check gate softened with no record authorizing it** — governance FAIL at
   `d9a41efa` ([comment 5325354868](https://github.com/kamp-us/phoenix/pull/5993#issuecomment-5325354868)).
   `ci.yml` gained `workflow_dispatch` while `e2e_required` kept `github.event_name ==
   'pull_request'`, so on a dispatched run the `e2e` job skips and `ci-required` reads that skip as
   a legit-skip PASS at a branch ref — replacing a red `ci-required` on a PR head with a green one
   without e2e running. That softens ADR [0092](0092-gates-fail-closed-on-zero-scope.md)'s
   no-silent-no-op invariant and cuts against ADR [0071](0071-enforce-control-plane-at-github.md).

The code namespace passed all six acceptance criteria at that second head and still FAILed only on
doc accuracy. Neither defect is an acceptance-criterion miss, which is why only the governance read
could find them, and both sat on the exact head the old reading declined to govern.

## The parked lane

A lane already parked in this deadlock is cleared by a human `UNBLOCKED`, not by a new rule alone —
the park is a recorded state and the machine does not un-park itself. On resume the reviewer fires
governance at the current head under this record, the FAIL becomes recordable, and the repair
dispatches. Lane 5718 has already been run through that route: it took the FAIL-round governance
exercise, which caught the two defects above that the code verdict would not have, and it then went
on past its repair cap under a driver cap-clear disclosed on the lane. It left this deadlock by that
route, not by waiting for a rule change.

## Consequences

No `harness: true` PR can park at its first FAIL for want of a governance verdict, and the review
gate's per-round cost on governance-root diffs rises by one governance run per repair round. The
`review` §6 text now states the obligation on both arms, and `operate`'s third `FAIL`-row refusal
reads as a floor that is always reachable rather than one a reviewer can strand. `lane prove` is
unchanged: it keeps enforcing the floor mechanically on the PASS arm only, and the FAIL half remains
prose in `operate` and `review`, which this record makes consistent.

## Records

no vocabulary impact
