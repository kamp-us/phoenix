---
id: 0074
title: '`/adr` claims its number with an in-flight reservation lock (label akin to ADR 0059), not next-free-on-disk — detect-and-serialize against open ADR PRs, with the ADR 0066 CI dup-check as the backstop'
status: accepted
date: 2026-06-16
tags: [pipeline, skills, adr, decisions, concurrency, agents]
---

# 0074 — `/adr` claims its number with an in-flight reservation lock, not next-free-on-disk

## Context

`/adr` Step 1 reads `.decisions/index.md` to "find the next number" (4-digit, monotonic)
**at author/branch time**. But the on-disk index — generated from the merged `.decisions/`
files (ADR [0066](0066-generate-decisions-index.md)) — reflects only **merged** ADRs, never
the ADRs in-flight on sibling PR branches. Under parallel ADR authoring plus the fast
autoship pipeline, "next free number on disk" goes stale within seconds: two branches both
read the same highest-merged `id` and both grab `next`.

This is a real, recurring collision, not a hypothetical:

- **0067 / PR #418** (`umut/adr-milestone-strategy`) was allocated 0067 while
  `0067-sparse-typecheck-bootstrap.md` merged in parallel — a head-on collision resolved
  only by a manual renumber (0067 → 0072) + rebase.
- ADR [0066](0066-generate-decisions-index.md) records the **same sibling problem** hitting
  twice before that: 0059 (#325) and 0064 (#370). Even authoring *this* ADR had to be told
  its number out-of-band (0072 just merged from #418; 0073 is claimed by open PR #426) —
  computing it from the on-disk index would have been the very bug.

### Why a decision, not a one-line fix

The allocation gap is genuine, but the corrective mechanism is an open fork with three
mutually-exclusive candidates (the issue #420 brief). Each is a different *kind* of change —
skill-step vs. pipeline-step vs. numbering-convention — so picking one is the deliverable:

1. **Allocate at merge time, not author time** — defer the `id` until the PR merges
   (a merge/ship-it normalize-renumber step), so the number is chosen against an up-to-date
   `main`.
2. **A claim/reservation lock akin to the epic-plan lock** (ADR
   [0059](0059-epic-plan-lock.md)) — before grabbing a number, query the *in-flight* ADR PRs
   and reserve against them, so a second author detects a number already claimed and steps to
   the next free one. Same detect-and-serialize (window-narrowing, not CAS) framing 0059
   already carries.
3. **A non-colliding numbering scheme** — replace the dense monotonic `id` with something two
   branches can't both pick (content-hash / timestamp / random-suffix), or "allocate sparse
   then normalize," trading clean sequential numbering for collision-freedom.

### Scope boundary — what already shipped (and why it is *not* the fix)

This is the number-**allocation** gap, distinct from the index-**generation/detection** work
already merged. ADR [0066](0066-generate-decisions-index.md) + #384 generate `index.md` from
the ADR files and add a CI `check` that **detects a duplicate `id`** (reddens CI). That is
post-hoc **detection at merge/CI time**, not collision-free **allocation**: two branches still
grab the same number at author time; the CI check only turns a silent dual-claim into a red CI
that forces the manual renumber+rebase on the *loser*. `/adr` Step 1 is unchanged. Generating
the index does **not** close this gap — and #204 (the `index.md` *merge* textual conflict) is
a third, separate problem that generation already closed. This ADR is solely about how the
number is *chosen*.

## Decision

**`/adr` claims its number with an in-flight reservation, not next-free-on-disk.** Before
writing the file, Step 1 computes the next free number from the union of `{merged ADRs on
the base ref} ∪ {numbers claimed by open ADR PRs}` — it queries the in-flight ADR PRs and
takes the first number free across *both* sets, rather than only the highest merged on disk.
This is the **claim/reservation-lock** mechanism (candidate 2), the direct analogue of the
epic-plan lock (ADR [0059](0059-epic-plan-lock.md)) one layer down: a **detect-and-serialize**
reservation over the open ADR PRs.

### 1. The concrete `/adr` Step 1 change this decision names

Today Step 1 reads:

> Read `.decisions/index.md` to find the next number. Numbers are 4-digit zero-padded,
> monotonic.

The decision replaces that single on-disk read with a two-source max:

- **Merged set** — the numbers on the base ref (`.decisions/NNNN-*.md` filenames, the
  authority; `index.md` is generated output per ADR 0066 and merely mirrors them).
- **In-flight set** — the numbers claimed by **open** ADR PRs. Enumerate them with one
  `gh` call against the open PRs that add a `.decisions/NNNN-*.md` file, e.g.
  `gh pr list --state open --json files` filtered to added decision files (or the search
  form `gh search prs --state=open` over the same), extracting each claimed `NNNN`.
- **Reserve** the first integer free in the union, zero-pad to 4 digits, and proceed. The
  number is **claimed implicitly by opening the PR** — the open PR *is* the reservation
  (it carries the `.decisions/NNNN-*.md` file the next author will see), exactly as ADR
  0059's `status:planning` label *is* the epic lock. There is no separate reservation
  artifact to create or release; the PR's lifecycle is the lock's lifecycle (opening
  reserves, merging/closing releases). The acquire **fails closed**: if the in-flight query
  errors, do not silently fall back to the on-disk-only number (that is the bug) — surface
  the failure so the author re-runs, consistent with 0059's fail-closed acquire.

This is a **skill-step change only** — no new pipeline stage, no new CI job, no
schema/convention change. It composes with the ADR 0066 / #384 CI dup-check unchanged: the
lock narrows the race at author time, the CI check catches whatever slips the residual
window at merge time.

### 2. Honest residual — this is detect-and-serialize, not a CAS

Querying open PRs and picking the first free number is a **TOCTOU**, identical in shape to
the epic-plan lock (ADR [0059](0059-epic-plan-lock.md) §2) and the issue-claim race (#260):
two authors who enumerate the open ADR PRs in the same window both see the same in-flight set,
both compute the same first-free number, and both open a PR claiming it. There is no
compare-and-swap on "the next ADR number" — GitHub offers no atomic reserve-a-number
primitive, and the PR-as-reservation only becomes visible to the *other* author once the PR is
actually open. So the reservation **narrows the window** from "every parallel author collides"
(today: the on-disk number ignores all in-flight work) to "only authors who open within the
same enumerate-then-open gap collide" — it does **not** eliminate it.

We do not claim a guarantee the mechanism can't give. We claim: the *common* interleaving — an
author branching minutes or seconds after another's ADR PR is already open — is serialized,
because the later author now *sees* the earlier open PR's number and steps past it. The
residual co-acquire window (two authors opening near-simultaneously, before either PR is
visible to the other) is **narrowed, not closed**, and its backstop is the ADR 0066 / #384 CI
duplicate-`id` check: a collision that slips the window reddens CI on the second-to-merge PR
and is renumbered then — the same "detect-and-tiebreak the loser at the gate" discipline #260
and ADR [0058](0058-sha-bound-verdict-contract.md) settle for their own last-write-wins
primitives. The lock turns the *common* case from collide-and-renumber into don't-collide; the
CI check remains the safety net for the *rare* residual.

### 3. Why not the other two candidates

- **Merge-time allocation (candidate 1) — rejected.** It is cleaner in theory (the number is
  picked against an up-to-date `main`, so it can't be stale), but it pays for that with real
  costs this repo should not take on. It adds a **renumber/normalize step to ship-it** (or a
  CI step), and ship-it is the single most safety-sensitive control-plane skill we keep
  deliberately dumb — "assert the gate + squash-merge, nothing clever" (ADR
  [0048](0048-ship-it-merge-actor.md)); ADR [0066](0066-generate-decisions-index.md) already
  **rejected** adding rebase/conflict logic to ship-it for this exact family of friction, and
  a merge-time renumber is the same kind of merge-actor complexity. Worse, it **breaks
  author-time cross-references**: an ADR routinely cites sibling ADRs by number in its own body
  (this file cites 0048/0058/0059/0066), and the `id` front-matter, the filename, and the
  in-body `# NNNN —` heading must all agree — if the number isn't known until merge, none of
  those can be written at author time, and a merge-time rewrite would have to rewrite the
  filename, the front-matter, the heading, **and** every inbound cross-reference from other
  files. That is a far larger and more fragile change than the gap warrants.

- **Non-colliding numbering scheme (candidate 3) — rejected.** A content-hash / timestamp /
  random-suffix `id` is collision-free by construction, but it **discards the dense sequential
  numbering** that is the whole ergonomic point of the ADR log: "read ADR 0066," a sortable
  monotonic index, "supersedes 0049," a number a human can say out loud. The index generator
  (ADR [0066](0066-generate-decisions-index.md)) orders by `id` and the supersede convention
  threads numbers through bodies; a non-monotonic id breaks both the human affordance and the
  existing tooling, to solve a low-frequency papercut. "Allocate sparse then normalize" is just
  candidate 1's merge-time renumber wearing a numbering-scheme hat, and inherits its
  cross-reference breakage.

The chosen mechanism is the **minimal** one that actually shrinks the race: a skill-step edit,
matching an established in-repo precedent (ADR 0059), composing with the already-shipped CI
backstop, and preserving dense monotonic numbering and author-time cross-references.

## Consequences

- **The common parallel-author collision is closed; the residual is narrowed, stated.** An
  author who branches after another's ADR PR is open now sees and steps past that number, so
  the recurring "two branches both grab `next`" (0059/#325, 0064/#370, 0067/#418) stops being
  the *common* case. The residual co-acquire window (two PRs opened near-simultaneously, before
  either is visible to the other) is **narrowed, not eliminated** — it is detect-and-serialize,
  not a CAS (Decision §2), and is backstopped by the ADR 0066 / #384 CI duplicate-`id` check.
- **ship-it and the numbering convention are untouched.** No merge-time renumber, no new
  pipeline stage, no non-monotonic id — ship-it keeps its ADR
  [0048](0048-ship-it-merge-actor.md) "assert + squash-merge, nothing clever" shape, and the
  dense sequential `id` (and the cross-references and supersede chains built on it) is
  preserved.
- **New cost: one `gh` query per `/adr` run.** Step 1 gains an enumerate-open-ADR-PRs call on
  top of the on-disk read. A transient failure **fails closed** (surface and re-run), never a
  silent fall-back to the stale on-disk number — that fall-back is the bug this ADR removes.
- **Composes with, does not replace, ADR 0066 / #384.** Generation removed the `index.md`
  *merge* collision and added the CI dup-`id` *detection*; this ADR adds collision-avoidant
  *allocation* in front of that detection. The CI check is now the **backstop** for the
  narrowed residual rather than the only defense.
- **Implementing edit ships as a follow-up.** The `/adr` Step 1 rewrite named in Decision §1
  is **not** in this PR (this PR records the decision only). It is tracked as
  [#428](https://github.com/kamp-us/phoenix/issues/428) (`status:needs-triage`, milestone
  *Pipeline hardening*). Until it lands, `/adr` Step 1's on-disk read remains the interim
  procedure, with the CI dup-check catching collisions at the gate.
- **Relationship.** Direct analogue of the epic-plan lock (ADR
  [0059](0059-epic-plan-lock.md)) one layer down — a detect-and-serialize reservation over
  open PRs, with the same window-narrowing-not-CAS honesty (and the same lineage:
  issue-claim TOCTOU #260, the SHA-bound verdict contract
  [0058](0058-sha-bound-verdict-contract.md)). Builds on ADR
  [0066](0066-generate-decisions-index.md) (which supplies the CI backstop and the
  generated-index authority). As a `.decisions/**`-only change this ADR is non-control-plane
  → review-doc-gated (ADR [0053](0053-control-plane-boundary.md)); the named `/adr` skill edit
  in the follow-up is `skills/**` → code-gated (ADR
  [0063](0063-skills-are-code-gated.md)).
