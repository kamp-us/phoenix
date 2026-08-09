# `check-epic-plan` — authoring notes

Reference for a reader or a future authoring session, not for a run. The hypotheses the eval gate
tests, the questions carried open, and the packaging choice live here rather than in
[`SKILL.md`](SKILL.md) because the model acts on none of them mid-gate — the §5 information
hierarchy puts reference behind a pointer, and the leaf rule keeps per-surface material in a file
until a second consumer earns it a skill of its own.

## Hypotheses under eval test — not law

Each: claim · falsifier · seam that changes if falsified (#4891: cite a measurement or mark it a
hypothesis).

- <!-- anchor: H1 --> **The advisory layer earns its context.** Claim: caveats from a model reading
  the ledger catch plan defects the floor cannot express, at a rate worth the tokens. Falsified by:
  caveats that only restate floor defects, or that no downstream reader acts on. Seam: `SKILL.md`
  step 4 — the layer is deletable without touching a verb.
  **First measurement (2026-08-09, 6 evals × 2 arms):** the layer produced caveats no floor defect
  covered on eval-1 (`ac-not-checkable` on an unfalsifiable criterion) and eval-3
  (`dependency-implied-not-declared` on an undeclared ordering) — both real, neither a restatement.
  Counter-evidence from the same runs: `FLIP-PARTIAL` has **no caveat emit path**, so a run that
  forms caveats on that terminal drops them. That is H1's own falsifier firing on one terminal.
- <!-- anchor: H2 --> **Scope-digest binding is the right drift key.** Claim: binding a verdict to
  the scanned child set makes staleness structural rather than detected. Falsified by: digests that
  churn on edits the floor does not read, making every verdict Stale. Seam: the digest's field list
  in [`contract.md`](contract.md).
  **Known incompleteness, stated rather than assumed away:** `DANGLING_DEP` rests on a referenced
  issue being *proven present*, and no digest field records that. So `21` cannot detect that
  particular drift; only the flip's own re-gate can. The digest covers the ledger's text, not the
  existence of everything the ledger points at.
- <!-- anchor: H3 --> **A terminal defective path beats a convergence loop.** Claim: handing a
  defective plan back to `plan-epic` outperforms driving re-plan rounds from inside the gate.
  Falsified by: epics that ping-pong between the lanes without converging. Seam: `SKILL.md` step 2's
  terminal.

## Defects the eval runs surfaced

A searchable home for findings that would otherwise live only in an issue comment, which GitHub's
search API does not index.

- <!-- anchor: D1 --> **Post-flip label state was assertable on `FLIP-PARTIAL`**
  ([#5151](https://github.com/kamp-us/phoenix/issues/5151)). Step 3 banned a fabricated per-child
  *table* and not the *claim*, so both arms of eval-4 stated what un-flipped children carried after
  the flip — state no surface in the run had read back. Found in iteration 2 of the eval runs, after
  eval-4's assertion 5 was repaired (iteration 1 could not see it); held unpatched under the
  authoring session's freeze rule so the benchmark stayed honest, then bounded in `SKILL.md` step 3
  with a pointer on the `FLIP-PARTIAL` terminal. The bound's reasoning lives at step 3, not here.

## Open questions — carried open, not answered

This skill proposes, never resolves; a ruling enters through report → triage.

- <!-- anchor: Q1 --> **Legacy rows against the two barrier defects.** Pre-existing
  `ready-for:human` children with empty assignee slots fail the floor, and one such child blocks the
  flip for every sibling. Back-fill vs grandfather is unruled
  ([#5026](https://github.com/kamp-us/phoenix/issues/5026)). The contract takes the refusing arm and
  names the seam (its floor table, row 13).
- <!-- anchor: Q2 --> **Nothing fires this gate.** No workflow, verb or guard notices a planned epic
  that was never gated ([#4104](https://github.com/kamp-us/phoenix/issues/4104);
  [#5040](https://github.com/kamp-us/phoenix/issues/5040) is the live instance). This skill is
  dispatchable but not detectable; whether detection belongs here or to the lane is open.
- <!-- anchor: Q3 --> **Mutual exclusion with the planner.** This gate claims the epic via
  `build claim`; the exclusion holds only if `plan-epic`
  ([#4712](https://github.com/kamp-us/phoenix/issues/4712), unauthored) claims the same way. Until
  that brief lands, the guarantee is a convention, not a mechanism.

## Packaging

Model-invoked entry skill, one directory, no leaf skills. The caveat kinds are a closed vocabulary
in `SKILL.md` rather than a rubric leaf — the leaf rule's two-consumer bar is unmet. Eval obligation
rides that choice: this skill's eval suite enumerates the gate's own cases, which it does across the
ten in [`evals/evals.json`](evals/evals.json).
