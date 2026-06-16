---
id: 0048
title: ship-it — the pipeline's single merge authority closes the loop (consumes review-code's PASS marker; sole merge step)
status: accepted
date: 2026-06-13
tags: [pipeline, skills, ship-it, review-code, agents]
---

# 0048 — ship-it — the Pipeline's Single Merge Authority Closes the Loop

## Context

The issue-intake pipeline (`report` → `triage` → `plan-epic` → `write-code` →
`review-code`) manufactures verified PRs but **could not ship them**. `review-code` is
forbidden to merge — its own words: *"you never merge… a human, or whatever downstream step
the repo later authorizes."* That downstream step was never built. On a pass, `review-code`
posts a `review-code: PASS — merge-ready` marker (formats §5) and stops — **a producer with
no consumer.** Every verified chain stalled at an unmerged PR waiting for a human; the
most-cited recurring friction across mined sessions was exactly this ("did you push?",
"squash-merge it?").

A second, structural reason the merge must be a skill, not a human convention: the single
operator on this repo (`usirin`) **cannot post an approving review on their own PR** under
org branch rules, so on the common path `review-code` falls back to the marker comment. A
marker comment is inert unless something reads it. The merge step therefore has to be a
programmatic consumer that treats the marker as a first-class PASS signal — there is no
human "Approve and merge" button that fits the single-operator reality.

ADR [0047](0047-review-plan-gate.md) added a deterministic *verification* gate (`review-plan`)
*before* `write-code`; it explicitly leaves merge undefined ("review-code never merges on
its own authority"). This ADR adds the missing *terminal* stage that closes the loop after
`review-code`.

## Decision

phoenix adds a **`ship-it`** skill — the single stage authorized to merge a PR — and it is
the **only** skill granted merge authority.

1. **One PR per invocation, atomic and idempotent.** `ship-it` takes one PR: resolve its
   `Fixes #N`, assert the PASS signal, confirm CI is already green (one read, no poll loop),
   `gh pr merge --squash`, confirm the issue auto-closed. Re-running on an already-merged PR
   is a clean no-op. Sweeping all open PRs is the driving loop's job, not this stage's. A
   **linked issue is expected, not optional** — in this pipeline `write-code` always writes
   `Fixes #N`, so a missing link is a broken seam, and `ship-it` stops on it rather than
   shipping an unlinked PR that would auto-close nothing and leave dangling work. (Distinct
   from the linked-but-didn't-auto-close case, where the seam fired but GitHub didn't close
   the issue — that one `ship-it` recovers by closing explicitly.)

2. **It consumes review-code's merge-ready signal — the marker comment is the default.**
   `ship-it` accepts either a native approving review **or** the
   `review-code: PASS — merge-ready` marker comment, recognized tolerantly by shape. The
   marker is the default path (the single operator can't approve their own PR), so `ship-it`
   exists precisely to be the marker's consumer.

3. **Two hard guards.** (a) Merge only on the *presence* of a PASS signal, never on the
   *absence* of a failure — no marker/approval → stop and report unverified. (b) `ship-it`
   is the *sole* merge authority; a PR that hasn't passed `review-code` is routed back
   through review-code, never merged here.

4. **Red CI hands off, never overrides.** If `gh pr checks` shows red, `ship-it` does not
   merge — it routes the failure to the self-heal lane (`heal-ci`) and reports "not shipped."
   Pending checks → "not yet"; the caller re-invokes after CI settles. `ship-it` owns no
   wait-loop.

5. **review-code names `ship-it` and makes FAIL a recognizable seam (paired change).**
   `review-code`'s "Authority limit" and pass-path now name `ship-it` as the authorized
   consumer, and its FAIL verdict's first line (`review-code: FAIL — not merge-ready`) is a
   recognizable marker — the seam `write-code`'s future resume-my-failed-PR round-trip keys
   on. The formats doc §5 documents both markers and names `ship-it` as the PASS consumer.

## Consequences

- **Easier:** the pipeline closes end to end without a human at the merge — a verified PR
  becomes a merged PR + a closed issue in one deliberate, auditable step. The inert PASS
  marker finally has a consumer.
- **Closed loop, single writer:** every other skill's "you never merge" invariant is now
  *true by construction* because `ship-it` is the one writer of the merge. The merge moves
  from an informal human act to a guarded, idempotent, reportable stage.
- **Harder / new cost:** a new stage to keep in step with CI conventions; `ship-it` must
  recognize the marker tolerantly and refuse on any ambiguity (refusal is a successful run).
- **Banned:** any other skill merging; merging on the absence of a failure (only the
  presence of a verified PASS); a wait-loop inside `ship-it` (CI polling is the driver's
  concern); auto-overriding a red check (route to `heal-ci`).
- **Relationship:** completes the pipeline ADR 0047 left open — 0047 gates the *plan* before
  write-code, `ship-it` ships the *PR* after review-code; both keep "verify" and "act"
  separate (review-code verifies, ship-it merges; review-plan verifies, neither repairs).
  The self-heal hand-off target `heal-ci` is a separate proposed skill; until it exists,
  `ship-it` simply reports "checks red — not shipped."
