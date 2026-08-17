---
id: 0283
title: Only an ordering this tree can own moves into the local lane ledger, never shared truth
status: accepted
date: 2026-08-17
tags: [fabrika, pipeline, state]
---

# 0283 — Only an ordering this tree can own moves into the local lane ledger, never shared truth

**What this decides:** the local `.fabrika` lane ledger holds drive-loop mechanics and nothing else — verdicts, claims, merge-queue position and labels stay on GitHub, which settles the migration question rather than postponing it.

## Context

Epic [#5680](https://github.com/kamp-us/phoenix/issues/5680) replaces fabrika's scattered engine
state with a local append-only log folded through `@demlik/tea`. Phase 1 landed the lane ledger
(`packages/fabrika-cli/src/lane/`), phase 2 landed the driver and froze the superseded subsystems,
and phase 2 **cut** one named item: migrating review/ship verdict contracts into ledger events.

A cut reads as a delay. It is not one here.
[`reports/2026-08-16-fabrika-tea-fold-survey.md`](../reports/2026-08-16-fabrika-tea-fold-survey.md)
(#5694) read all 25 verb groups and all 24 skills against the one existing fold and answered the
question the cut left hanging: verdict currency, claim races, queue position and label facets are
`no (board)` — not "not yet", but "the ordering arbitrates between checkouts a per-tree log cannot
see". Without a record, the next planner reads phase 2's cut as a backlog item and re-proposes the
port. This ADR ratifies the survey's read so that stops happening. It rules nothing the survey did
not.

It supersedes and amends nothing. It agrees with the live records that already put these facts on
GitHub: [0115](0115-agent-distinguishable-claim-marker.md) (the claim marker is a GitHub comment),
[0272](0272-lane-owns-the-claim.md) (the lane owns that claim through merge or abandonment), and
[0276](0276-verdict-binds-content-not-only-head.md) (a fabrika verdict binds the PR's content). This
record explains why none of the three can move into a per-tree log.

## Decision

**A fact moves into the local lane ledger only when its ordering is one this working tree may own;
every ordering that arbitrates between checkouts stays on GitHub, and the board remains the shared
source of truth.**

The lane ledger's shape is the test. `packages/fabrika-cli/src/lane/store.ts` reads
`.fabrika/lanes/<n>/events.jsonl` (gitignored, per-tree), `lane/fold.ts` re-folds the whole log every
invocation with nothing stored derived, `lane/machine.ts` derives the compound state as a pure
function of that log, and `lane/templates/coder.workflow.json` carries the retry budget as machine
context enforced by a `retriesRemaining` transition guard. That is a drive loop: one tree, one
sequence, one owner. Nothing outside that description moves.

**Two refusal classes, each closed.**

*Refusal 1 — the ordering is real but the board owns it (`no (board)`).* The sequence exists, and it
decides between sessions in different checkouts, so a per-tree log could cache its outcome but could
never arbitrate it:

- **Verdict currency** — `review/head.ts` (`bindHead`), `review/content-binding.ts`
  (`contentDigestAt`), `review/write-recency.ts` (the `Verdict-written:` stamp as the ordering key),
  and `ship/gate-verb.ts` (`inForce`). The verdicts being ordered are written by one session and
  consumed by another.
- **Claim races** — `build/claim.ts` (`markersIn` → `resolveOwnership`) and `triage/claim.ts`.
  Earliest-authorized-marker-wins is a fold, and it is exactly the fold that has to be visible to
  the competing lane.
- **Merge-queue position** — `ship/queue.ts` (`queueStateOf`) folds GitHub's own timeline events. We
  fold that stream; we do not own it.
- **Label facets** — `triage/facets.ts` and `plan/flip-verb.ts`. Labels are simultaneously the shared
  truth and the write target.
- **Every artifact one session writes for another to read** — `handoff/packs.ts`, `governance`'s
  readout comment, `graduate/trail.ts`'s source markers.

*Refusal 2 — it is not an ordering at all (`no (not an ordering)`).* A pure function of one snapshot,
where reordering the inputs changes nothing:

- `build/tree.ts` (`readTree` / `assertGround`) — git porcelain, a snapshot of the working tree.
- `review/rollup.ts` (`rollupOf`) — a total over a set of check runs.
- `pattern/drift.ts` and `glossary/drift-verb.ts` — functions of committed bytes.
- `ship`'s guard chain — `ship/scope-verb.ts`, `ship/codeowners.ts`, `ship/checks-verb.ts`,
  `ship/threads.ts` are independent predicates over the PR's current state, each re-reading fresh and
  carrying nothing to the next. The chain is not a machine; its only ordering is the skill's reading
  order, chosen so the cheapest refusal fires first.

**`partial` in the survey means the derivation has a fold's shape. It never means the log should move
local.** This is the exact misreading this record exists to prevent. `build/rounds.ts`'s `countRounds`
and `ship/queue.ts`'s `queueStateOf` are textbook folds and both stay where they are, because a
fold's shape says how a state is *derived*, not where its events may *live*.

**Two other local JSONL logs are left alone deliberately.** `spend/ledger.ts`
(`.fabrika/spend-ledger.jsonl`) is append-only but its derivation is a sum — reorder the rows and the
answer is identical, which is the test a fold fails. `spike`'s `evidence.jsonl` (under
`spike/workspace.ts`'s workspace root) is append-only but its derived fields are a tail read and a
count. Neither is a machine; folding them through tea would buy vocabulary and nothing else.

**Binding constraints.**

- Phase 2's cut of verdict migration is **closed, not deferred**. Do not file, plan, or build a port
  of verdict currency, claim arbitration, queue position or label facets into the lane ledger.
- Freezing a subsystem is not migrating it. The phase-4 freeze list stands; nothing on it acquires a
  migration by being frozen.
- A new local ledger needs both halves: an ordering this tree owns *and* a derivation that is a state
  machine. A log that is only append-only does not qualify.
- Reopening any refusal above requires a fact the survey got wrong about the source, named at the
  symbol — not a preference for local state.

## Consequences

Easier: a planner reading phase 2's cut now finds the answer instead of an apparent gap, and the
board keeps a single arbitration point for anything two checkouts contend over. The remaining
tea-fold work is small and named — the retry cap that exists three times, which is a deduplication,
not a migration.

Harder: the drive loop's mechanics live in one place and the coordination facts live in another, so
reading a lane's full story still means reading both. That split is the price of cross-checkout
arbitration, and it is deliberate.

Nothing is migrated by this record and no code changes.

## Records

no vocabulary impact — the terms used here (lane ledger, fold, board truth) are the survey's and the
already-landed phase 1–2 records'; this ADR coins nothing.

Sources: [`reports/2026-08-16-fabrika-tea-fold-survey.md`](../reports/2026-08-16-fabrika-tea-fold-survey.md),
epic [#5680](https://github.com/kamp-us/phoenix/issues/5680),
task [#5734](https://github.com/kamp-us/phoenix/issues/5734).
