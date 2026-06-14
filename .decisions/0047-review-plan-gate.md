---
id: 0047
title: The review-plan gate — deterministic plan-epic verification
status: accepted
date: 2026-06-13
tags: [pipeline, plan-epic, write-code, effect, agents]
---

# 0047 — The review-plan gate — deterministic plan-epic verification

## Context

The issue-intake pipeline runs `report` → `triage` → `plan-epic` → `write-code` →
`review-code`. `review-code` is a **gate**: it verifies a PR against its issue's
acceptance criteria before merge and never merges on its own authority. One stage
earlier there is no such gate. `plan-epic` is **autonomous with no approval step**, and
its output — the epic *ledger* (the brief, the `## Dependencies` topology, and the
linked sub-issue bodies) — flows straight to `write-code` **unverified**.

A malformed ledger reaches `write-code` intact: a child with zero acceptance criteria
(no definition of "done"), a `## Dependencies` edge pointing at a child the epic never
linked, a dependency cycle, an orphaned child, a missing or `status:needs-triage` label.
`write-code`'s pick predicate selects `status:triaged` children and starts building. A
structurally-broken child is therefore *pickable* — and a child with no acceptance
criteria is one `review-code` can never pass, because there is nothing to check (the
≥1-AC invariant in [`gh-issue-intake-formats.md`](../.claude/skills/gh-issue-intake-formats.md)
§2 exists precisely to stop this, but nothing enforces it).

The verification that *was* being run against the backlog was a non-deterministic LLM
prose pass. That has a second, subtler cost: its defect set is not stable run-to-run, so
it cannot anchor a re-plan loop that needs to detect "the same defect recurred." A loop
built on a non-deterministic signal cannot tell genuine progress from noise.

`@phoenix/epic-ledger` (`packages/epic-ledger`, built by [#160](https://github.com/kamp-us/phoenix/issues/160))
is the deterministic floor that fixes both: `validateLedger(EpicLedger) -> Defect[]` over
a closed defect enum, with an `isPickable()` flip predicate and a run-stable
`ledgerSignature()`. This ADR records the **architecture of the gate that wraps it** —
the symmetric twin of `review-code`, one stage earlier, at the plan layer. It fixes the
decisions settled for epic [#159](https://github.com/kamp-us/phoenix/issues/159) so the
implementation children ([#162](https://github.com/kamp-us/phoenix/issues/162)–[#166](https://github.com/kamp-us/phoenix/issues/166))
build to a settled shape instead of re-litigating it. (An earlier plain-TS validator
draft was built and **removed** per owner decision; the rebuild is Effect v4-native from
scratch — see Decision 4.)

## Decision

phoenix adds **`review-plan`**, a deterministic gate between `plan-epic` and
`write-code`. It is the symmetric twin of [`review-code`](../.claude/skills/review-code/SKILL.md):
where `review-code` verifies a PR against acceptance criteria and gates `write-code` →
merge, `review-plan` verifies an epic ledger against the structural floor and gates
`plan-epic` → `write-code`. Like its twin, it **signals; it never does the next agent's
job** (`review-code` never merges; `review-plan` never repairs).

### 1. Structural enforcement, not advisory — the flip makes an unverified-but-pickable child unrepresentable.

`plan-epic` mints children **`status:planned`** (a new pipeline label, *not* pickable by
`write-code`). `review-plan` flips **`planned → status:triaged`** only on a clean
`validateLedger` (an empty hard-defect set). `write-code`'s existing `status:triaged`
pick predicate then enforces the gate **for free** — it already selects only
`status:triaged`, so a child that has not passed the gate is structurally unpickable.

*Rationale:* a gate that only prints a warning is bypassable. By moving the verified
state into the *label* `write-code` already keys on, "an unverified child got picked"
becomes unrepresentable rather than merely discouraged. (Chosen over orchestrator-only
sequencing — a decoupled, standing `write-code` loop would never see the orchestrator's
ordering and would pick an unverified child anyway; the invariant must live in shared
issue state, not in a runtime that one consumer might not run through.)

### 2. Deterministic floor blocks; the LLM soft-advisor never blocks.

Only the **hard-defect enum** in `@phoenix/epic-ledger` gates the flip — the closed,
deterministic set (`MISSING_DEPS_SECTION`, `DEP_CYCLE`, `DANGLING_DEP`, `ORPHAN_CHILD`,
`ZERO_AC`, `MISSING_LABEL`, `NEEDS_TRIAGE_LABEL`). A non-empty hard-defect set blocks the
flip; an empty one passes it. Judgment-shaped concerns — acceptance-criteria
*checkability* ("is this AC actually verifiable?"), brief-fidelity ("does the plan still
serve the brief?") — are produced by an **LLM soft-advisor** and attached to a PASS as
**advisory caveats. They never block the flip.**

*Rationale:* the floor is the set of defects a machine can decide identically every run;
gating on those is safe and stable. Gating the flip on a judgment call would deadlock the
pipeline on a subjective verdict an LLM cannot render identically twice — the same
non-determinism this gate exists to remove. Soft signal is worth surfacing, never worth
blocking on.

### 3. Flag, don't repair; converge on *stall*, not a fixed retry count.

`review-plan` mutates **only its own verdict and the label flip**. It does **not** edit
the ledger to fix a defect. Repair is the job of a **re-plan loop**: it re-invokes
`plan-epic` on a failing epic and re-validates. The loop continues while the
**hard-defect set strictly shrinks**, and **parks the epic at `status:needs-info`** when
it sees a **repeated `ledgerSignature`** (a cycle — the same ledger came back) or a
**non-shrinking defect set** (re-planning stopped making progress). Convergence is
**stall-based**, not a fixed retry budget; a high flat ceiling exists only as a runaway
backstop.

*Rationale:* keeping the verifier detached from repair is the same discipline that stops
`review-code` from merging — a checker that also fixes loses the independence that makes
its verdict trustworthy. And a fixed retry count is the wrong stop condition: it stops too
early on a still-improving plan, or burns budget on one that will never improve. The
run-stable `ledgerSignature()` is what makes "the same defect recurred" detectable — the
exact signal a non-deterministic LLM pass could not provide (Context).

### 4. Effect v4-native throughout.

`@phoenix/epic-ledger`'s domain types — `EpicLedger`, `Defect`, `DefectType` — are built
on **`effect/Schema`** and **decoded at the GitHub boundary** (untrusted `gh api` JSON is
parsed into the domain, not trusted raw). The IO shell, the gate action, and the
convergence loop are Effect-native: capabilities are `Context.Service`, methods are
`Effect.fn`, failures are `Schema.TaggedErrorClass`, and the loop's stall/backstop policy
is a `Schedule`. `gh api` is invoked via `effect/unstable/process` — **REST only; GraphQL
is broken on this org.** The repo's [`.patterns/effect-*`](../.patterns/index.md) docs are
the in-repo convention reference.

*Rationale:* owner decision. An earlier plain-TS draft (a pure `(EpicLedger) => Defect[]`
with Effect bolted on only at the IO edge) was built and removed; the rebuild is
Effect-native from the schema up, so the domain types, the boundary decode, and the
control flow share one idiom rather than straddling two.

### Pipeline touchpoints this implies (built by separate gated children, not in this ADR)

This ADR records the architecture; the moving parts land in epic [#159](https://github.com/kamp-us/phoenix/issues/159)'s
later children:

- **`status:planned`** — a new pipeline label, sitting *before* `status:triaged`.
  `plan-epic` is changed to mint children `status:planned` instead of `status:triaged`
  ([#162](https://github.com/kamp-us/phoenix/issues/162)); `write-code`'s pick predicate
  is **unchanged** — it keeps selecting `status:triaged`, which is exactly why the flip is
  the whole enforcement mechanism (Decision 1).
- **`plan-epic` touchpoint** — mint `status:planned`, not `status:triaged`
  ([#162](https://github.com/kamp-us/phoenix/issues/162)).
- **`write-code` touchpoint** — none to its logic; the gate works *because* its existing
  `status:triaged` predicate already excludes un-flipped children. The only thing that
  changes for `write-code` is that the label it keys on is now reached via the gate.

## Consequences

- **Easier:** an unverified epic ledger can no longer reach `write-code` — the structural
  floor is enforced by the same label predicate `write-code` already runs, so the
  invariant holds even for a decoupled standing loop. The re-plan loop has a *stable*
  defect signal (`ledgerSignature`) to converge against, which a non-deterministic LLM
  pass could not give it.
- **New label in the pipeline:** `status:planned` is now the state a freshly-planned child
  sits in until the gate flips it. Anything that reasons about "ready to pick" must know
  `status:triaged` is now a *post-gate* state, not the immediate output of `plan-epic`.
- **`plan-epic` output is no longer directly pickable.** A child is born unpickable and
  becomes pickable only on a clean validate. This is the intended cost: the price of the
  guarantee is one extra state and one gate pass per epic.
- **Harder / new cost:** the re-plan loop is a new autonomous moving part with its own
  stall semantics to get right (cycle detection via `ledgerSignature`, non-shrink
  detection); a wrong stall rule either spins or parks a salvageable epic. The soft-advisor
  is a second LLM surface to maintain (its caveats inform but never gate).
- **Banned:** gating the flip on a soft/judgment signal (only the closed hard-defect enum
  blocks — Decision 2); a verifier that repairs the ledger it checks (repair is the
  re-plan loop's job — Decision 3); a fixed retry budget as the loop's stop condition
  (converge on stall — Decision 3); a plain-TS core for the validator (Effect v4-native
  throughout — Decision 4); any `gh` GraphQL call (REST only).
- **Relationship to [`review-code`](../.claude/skills/review-code/SKILL.md):** `review-plan`
  is its structural twin one stage earlier. Both gate without doing the next agent's job —
  `review-code` verifies a PR and never merges; `review-plan` verifies a ledger and never
  repairs. The two gates bracket `write-code` on both sides: the plan it consumes is
  floor-verified going in, the PR it produces is AC-verified going out.

## Amendment (2026-06-13) — first real-epic run: operable surface + two floor corrections

The gate had never run against a real epic — the floor was fixture-tested only, and there
was **no executable surface** to invoke `runGate` (the skill named it, but nothing wired it
to a runnable entry). The first dry-run sweep over the live backlog (#41/#73/#82/#83/#89/
#102/#113) surfaced two false positives in the floor that only real ledgers expose. This
amendment records the three changes; all stay within the Decisions above (Effect-v4-native
core, deterministic floor, flag-not-repair).

1. **Operable surface — `epic-ledger` CLI.** `packages/epic-ledger/src/bin.ts` wires the
   existing `runGate` over `effect/unstable/cli` + `NodeRuntime.runMain`, with the live
   `Github` capability provided through `NodeServices.layer` (the `ChildProcessSpawner` that
   shells `gh`). `epic-ledger <EPIC>` is the live gate; `--dry-run` validates and prints
   without flipping a label or posting a comment. This is the entry `review-plan` Step 1
   invokes — not a new framework, just the missing executable for the action the ADR already
   defined.

2. **`DANGLING_DEP` resolves cross-epic edges at the boundary.** A `requires:` ref to an
   issue owned by *another* epic (e.g. #113's CLI verb requiring the imge backend #108/#109)
   is a legitimate gating edge, but the pure floor flagged every non-child referenced node
   as dangling. The decode boundary (`github.ts`) now probes each non-child ref: one that
   resolves to a real issue rides in a new `EpicLedger.externalRefs` and is **not** flagged;
   a 404 still dangles; any other `gh` fault propagates (no silent demotion of a real
   dependency). The floor stays pure over the richer ledger — `DANGLING_DEP` fires only on a
   ref that resolves to nothing. (The formats contract already allowed `requires:` to name
   "other issues" generally; this aligns the floor with it.)

3. **`MISSING_STORIES_SECTION` — epic-level story-coverage floor.** Widens the closed defect
   enum by one (a deliberate contract widening, per `Defect.ts`). The story-coverage
   invariant required every child to carry `**Stories:**` but had no check that the *epic*
   declares a `### User stories` section — so an epic with none (legacy, pre-story-coverage:
   #73/#83/#89) failed with N confusing per-child `MISSING_STORY` defects instead of one
   legible root cause. `MISSING_STORIES_SECTION` is the story-side mirror of
   `MISSING_DEPS_SECTION`; when it fires, the per-child `MISSING_STORY` is suppressed.

Verified end-to-end against a throwaway scratch epic (created and torn down in one run):
PASS flips `status:planned → status:triaged` + posts the verdict comment; a zero-AC child
yields FAIL with nothing flipped; the gate is idempotent on re-run. 70/70 package tests
green.
