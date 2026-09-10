---
id: 0301
title: The blocked_by graph is the one carrier of blockedness, and the claim seam enforces it
status: accepted
date: 2026-08-19
tags: [fabrika, pipeline, board, agents]
---

# 0301 — The blocked_by graph is the one carrier of blockedness, and the claim seam enforces it

**What this decides:** an issue that must not be started yet says so through GitHub's native
`blocked_by` edges and nothing else. The `status:blocked` label is retired, `build claim` reads the
graph and refuses a blocked number, and a blocking **pull request** is named in the graph by the
issue its merge closes.

This ADR transcribes a founder ruling and decides nothing on its own authority. The ruling is
[#6114, comment 5335606422](https://github.com/kamp-us/phoenix/issues/6114#issuecomment-5335606422)
(umut, 2026-08-18), reached through the ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md)
arm. Where the ruling delegated a mechanical shape to the builder, this file says so at that point.

## Context

On 2026-08-18 a `status:blocked` label was created and applied to seven issues waiting on an
unmerged PR: #6111, #6107, #6074, #6076, #6085, #6089, #6060. Each also carried `ready-for:agent`,
so the two labels said opposite things about the same issue and no verb resolved the conflict.

Three seams were read against the live repo and the live board while #6114 was triaged.

- `build pick` drops those issues, but by accident. `isCandidate` in
  [`pick-verb.ts`](../packages/fabrika-cli/src/build/pick-verb.ts) requires exactly one `status:`
  label and that it be `status:triaged`; a second `status:` label fails that hygiene test before the
  `excluded[]` accumulation runs, so the issue vanishes with no reason printed.
- `build claim` reads no blockedness at all. Its admission test
  ([`scope-admission.ts`](../packages/fabrika-cli/src/build/scope-admission.ts)) is two axes, scope
  and audience, and a number handed straight to a lane passes through no pool — so `fabrika operate
  6060` claims and builds today.
- `build eligible` answers `eligible` for all seven. It derives from a parent ledger, and a
  standalone issue has none, so it returns `{answer: "eligible", parent: null}` without reading the
  issue.

The label also contradicted a recorded ruling. #5387 settled that every dependency in fabrika sits
behind one structure — native `blocked_by` edges are authoritative, and a prose dependency block is
at most a rendering of them. A stored label is a second carrier of the same fact, and it goes stale
the moment its blocking PR merges, because nothing removes it.

## Decision

**The native `blocked_by` graph is the one carrier of "do not start this yet", for a standalone
issue exactly as for an epic child. `status:blocked` is retired. `build claim` reads the graph and
refuses a blocked number with a named exit.**

### It upholds #5387; nothing is carved out of the graph

The ruling extends the one-structure rule to a population #5387 did not reach — standalone issues,
which have no parent ledger — and it removes the competing carrier rather than adding one. No prose
grammar is parsed, no label is read, and no source outranks the graph anywhere. `build eligible`'s
existing prose `## Dependencies` read over an epic ledger is untouched by this ADR; migrating it is
#5913's, below.

### A pull-request blocker is the issue that PR's merge closes

This shape is the builder's call inside the ruling, which named the requirement and delegated the
mechanics.

A pull request never appears in the graph. The endpoints in
[`edges.ts`](../packages/fabrika-cli/src/io/edges.ts) post an `issue_id`, and the precondition being
recorded is not "this PR exists" but "this work lands" — which is an issue closing. So:

- When the blocking PR carries `Fixes #N`, the edge points at `#N`. Merging the PR closes `#N`, and
  the block is gone with no second act.
- When the blocking PR closes no issue, an issue is filed for the work and that PR is re-pointed at
  it. The per-blocker setup cost is real and is the price of never storing the state.

The reader must not treat a `blocked_by` entry as blocking on its own: the list returns every
blocker whatever its state, so the derivation is "any blocker issue still open" and it lives in the
reader, as [`edges.ts`](../packages/fabrika-cli/src/io/edges.ts) already says it must.

### Unblocking is derived; nobody performs it

There is no unblock act, and no label to drop. The edge stays; the blocker issue closes; the next
read answers unblocked. That is the whole reason the graph wins over the label — the stale-label
problem cannot be expressed.

### Where the check lands, and where it does not

**It is not a third axis inside the admission test.** That module is pure, total, and reads only the
facts already on an issue — two axes with two different remedies, kept separate on purpose (ADR
[0245](0245-campaign-scope-fence-binds-both-seams.md)). Blockedness is none of those things: it
needs a paged network read with a three-way existence answer, and its remedy is neither an edit nor a
re-label but waiting.

So the check is a **precondition gate in `build claim`, ordered after the two pure axes** — the axes
are free and answer without IO, and an out-of-focus number should be refused on that ground rather
than on a read it never needed. The refusal reuses the existing `BLOCKED` exit `16`
([`codes.ts`](../packages/fabrika-cli/src/build/codes.ts)), so blockedness has one code across every
seam that answers it, and the refusal names every open blocker rather than the first.

`build pick` gains a real exclusion. With `status:blocked` deleted, the incidental two-`status:`-label
drop stops firing at all, so pick would silently start offering blocked issues. It therefore reads
the same graph and reports `blocked` as a named reason on the `excluded[]` channel, beside
`out-of-focus`, `audience-not-agent` and `no-acceptance-criteria`. The honest cost is one dependency
read per surviving candidate, in a verb that today reads only label lists.

### The read fails closed

`blockedBy` answers three ways, and only one of them is "not blocked" (ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)):

- **Present, all blockers closed** — proceed.
- **Present, any blocker open** — refuse on `16`.
- **Absent (404: the issue does not exist) or Unknown (any other failure)** — refuse on
  `PRECONDITION_UNKNOWN` (`11`). A check that could not determine blockedness never resolves to
  "not blocked".

In `build pick`, an unreadable candidate is excluded with the reason stated, never silently kept.

### The seven issues, and who removes the label

Each of the seven migrates to a `blocked_by` edge pointing at the issue its blocking PR closes.
`status:blocked` is deleted from the repository after the last migration — deleting the label
removes it from every issue at once, so there is no per-issue unstamping step and no window where
some issues carry it and the verbs no longer read it. Deletion is part of the migration change,
which is where the label was created; it is not left to whoever merges each blocking PR.

### Ordering against #5913

#5913 absorbs the `build eligible` half — it already owns moving that verb from prose
`## Dependencies` to native edges, and it is the natural home for the shared reader. The claim-seam
gate, the `build pick` exclusion reason and the seven migrations are filed separately as
[#6249](https://github.com/kamp-us/phoenix/issues/6249) and ordered **after** #5913, so the reader
lands once and the second lane consumes it rather than writing a second one.

## Consequences

Blockedness becomes a thing the board already knows rather than a thing someone must remember to
stamp and un-stamp, and the answer is the same at every seam because there is one reader over one
source.

The cost is paid at write time and on the wire. Recording a block is no longer "add a label": it is
an edge, and where the blocker is a PR that closes nothing, an issue has to exist first. And both
`build claim` and `build pick` grow a network read they did not have — one call per claim, one per
candidate — which is the price of a derived answer.

Until #5913 and #6249 land, nothing enforces this. The seven issues keep `status:blocked`, and
`build claim` still admits them, so a directly-handed blocked number builds exactly as it did before
this ADR. That gap is stated rather than papered over: this file is the ruling, and the ruling is not
the wiring.

## Records

no vocabulary impact

> Amendment 2026-08-19: that gap is closed at head. The shared reader is `packages/fabrika-cli/src/build/blockedness.ts` (`readBlockedGate`), `build claim` refuses a blocked number (`claim-verb.ts`), `build pick` excludes one (`pick-verb.ts`), and the `status:blocked` label no longer exists on the repo.

> Amendment 2026-08-29 — **an edge also clears when the blocker's work lands on the epic run's
> assembly branch, and that discharge binds the claim seam.** The "Present, any blocker open" bullet
> under "The read fails closed" is narrowed to "Present, any blocker open **and undischarged**".
> Nothing else in this record moves: the graph is still the one carrier, `status:blocked` stays
> retired, and the claim seam still refuses a blocked number on `16`. Filed against
> [#7035](https://github.com/kamp-us/phoenix/issues/7035).
>
> **Why the closed-state read is the wrong proxy inside a run.** This record was written where "the
> blocker closed" and "the blocker's work landed" are one event: a blocking PR carries `Fixes #N`,
> its merge closes `#N`, and the next read answers unblocked with no second act — which is the whole
> basis of "unblocking is derived; nobody performs it" above. ADR
> [0285](0285-epic-machine-ends-in-review.md) breaks that identity for an epic child. An epic run
> opens **no PR per child** — every child's range lands on one shared assembly branch and the run
> ends in a single tail PR — so no closing keyword exists to close a child when its work lands, and
> the child's close is a separate act later in the run. Between those two moments the work is on the
> branch and the issue is open, and a gate reading only the closed state answers "still blocked"
> about work the next child is already building on.
>
> That is not hypothetical. Epic #6767's sequential tracers deadlocked twice in one night — `build
> eligible` said go and `build claim` refused `16` on the same edge — and each park was cleared by a
> human deleting the `blocked_by` record by hand, which destroys the one carrier this record
> establishes. The narrow reading did not preserve the invariant; it spent it.
>
> **What discharges, and what does not.** An open blocker is discharged when the assembly branch
> `epic/<parent>` adds a commit over the trunk naming it (`issueRefsIn`), per 0285. Discharge moves
> an answer only toward admitting: an unreadable branch, an unnameable trunk, and a standalone issue
> (no parent, so no derivable branch) each leave every edge exactly as the board read it and still
> refuse on `16`. A parent that could not be read is `11`, never an admission on evidence nobody
> read.
>
> **It authorizes both seams.** `build eligible` shipped this discharge under
> [#6063](https://github.com/kamp-us/phoenix/issues/6063) with no record; this amendment covers it
> there as well as at the claim seam. The derivation lives once, in
> `packages/fabrika-cli/src/build/discharge.ts`, so the two cannot drift again. `build pick` is the
> one seam still reading the undischarged gate, tracked as
> [#7223](https://github.com/kamp-us/phoenix/issues/7223).

> Amendment 2026-08-28 — **the pool answers from that derivation too.** `build pick` now runs the
> same `discharge.ts` gate, so the third answer that amendment left open is closed and
> `blockedness.ts`'s discharge-free `readBlockedGate` is deleted rather than left as a second door
> onto the same question. Nothing in the ruling moves: the graph is still the one carrier, discharge
> still only ever admits, and a candidate whose parent or edge list could not be read is excluded
> `unreadable` rather than offered. The lazy shape is what makes it affordable over a whole board —
> the parent resolve and the branch read fire only for a candidate the graph already refused. Filed
> against [#7223](https://github.com/kamp-us/phoenix/issues/7223).

> Amendment 2026-09-10 — **the claim-seam gate binds `--purpose build` and nothing else.** The
> purpose matrix is now part of this record: `build` refuses on `16` exactly as written above,
> `plan` and `gate` skip the graph read outright. Nothing else moves — the graph is still the one
> carrier, `status:blocked` stays retired, the discharge of the 2026-08-29 amendment still narrows
> the build arm, and the read still fails closed on that arm (an unreadable edge list is `11`, never
> "not blocked"). Founder ruling:
> [#7542, comment 5617229240](https://github.com/kamp-us/phoenix/issues/7542#issuecomment-5617229240)
> (umut, 2026-09-10) — "planning and plan-gating an epic is allowed while the epic it waits on is
> still open; only the actual build work stays blocked."
>
> **Why the build arm is the whole point of the gate.** What this record means by "do not start this
> yet" is *do not write code against a contract that has not landed*. Planning an epic writes a task
> ledger; gating one grades that ledger. Neither writes code, and both are the work that most wants
> doing while the blocker is being built, because every child of the downstream epic can start the
> moment the blocker lands only if its ledger already exists. Fencing them on the same edge inverted
> that: the downstream epic could not be planned until the blocker epic *closed*, which is the last
> event in its run rather than the first.
>
> That cost was paid four times before the ruling. `fabrika build claim --purpose plan` refused on
> `16` for #7497 (blocker #7496), #7499 (#7496 again, filed as #7543 and folded here), #8070
> (#7625) and #8716 (#8715). Each stop was worked around by hand — dropping the epic-level edges and
> keeping only the children's exact ones — which spends the one carrier this record establishes,
> the same failure mode the 2026-08-29 amendment was written to stop.
>
> **Nothing is unfenced by this.** The edge still refuses every claim that would write code: each
> child's own build claim reads its exact `blocked_by` edges, discharge and all, and `build pick`
> and `build eligible` are build-purpose questions by construction and are untouched. What the
> matrix removes is a refusal on the *epic's own* edge at a seam that produces a document.
>
> **The two consumers stop disagreeing with the producer.** `check-epic-plan`'s contract already
> declared `16` unreachable in that gate; before this it was true of the gate's own verbs and false
> of the claim it runs first. It is now true of both. `plan-epic` never had a `16` row in its
> terminal vocabulary, and now needs none: the code is unreachable from a `plan` claim, and both
> skills say so at the claim step. A skipped gate is printed rather than inferred —
> `build claim: blockedness: the gate binds a build claim only — …` lands where the `scanned` line
> would have — so a reader can tell "not blocked" from "not asked". Filed against
> [#7542](https://github.com/kamp-us/phoenix/issues/7542).

> Amendment 2026-09-10 — **"Nothing is unfenced by this" was wrong about the children, and the
> prerequisites carry down to fix it.** The paragraph of that name in the amendment above says each
> child's own build claim reads its exact `blocked_by` edges. That is true and it is not the whole
> answer, because nothing puts the *epic's* edge onto a child. So an external prerequisite recorded
> only at epic level refuses **the epic's own build claim and nothing else**. Read the sentence that
> way from here.
>
> Before the purpose split, that same edge fenced the children too, by accident: the epic could not
> take a `gate` claim, so `plan flip` never ran and no child was flipped `status:triaged`. Admitting
> the gate claim removed the refusal and the accidental fence with it. The plan gate's defect floor
> ([`defects.ts`](../packages/fabrika-cli/src/plan/defects.ts)) does not close the hole either — it
> checks that the graph agrees with the plan's prose, and reads nothing off the epic's own edge list.
>
> **Ruled: carry them down at plan time.** `plan-epic` writes every open target on the epic's own
> `blocked_by` list into each child's `## Dependencies` refs — the grammar already admits a `#<int>`
> outside the epic ([`dependencies.ts`](../packages/fabrika-cli/src/build/dependencies.ts)) — so
> `requiredEdges` derives a real per-child pair, `ledger edges` writes it, and each child's build
> claim refuses on `16` with discharge intact. The plan gate reads the epic's own `blocked_by` list
> and reds a plan that dropped one of its open targets. Ruling:
> [#8992, comment 5617977097](https://github.com/kamp-us/phoenix/issues/8992#issuecomment-5617977097)
> (2026-09-10), recorded by the EA under the driver's call of
> [#8807](https://github.com/kamp-us/phoenix/issues/8807) R4.1 and open to a founder override in one
> line.
>
> **Why not the other answer.** Declaring the per-child fence the intended shape was the live
> alternative, and it would have made a policy out of a side effect: the narrowing was ruled so a
> blocked epic can be *planned*, not so its children can be *built*.
>
> **Where it is enforced, and that it is not yet.** Two sites — a `plan-epic` contract clause for the
> write and a defect in the plan gate's floor for the check — filed as
> [#8995](https://github.com/kamp-us/phoenix/issues/8995) and ordered after
> [#7562](https://github.com/kamp-us/phoenix/issues/7562), which reports that `ledger topology`
> still refuses the very ref shape the clause asks a planner to write. Until both land, an
> externally-blocked epic's children stay unfenced. This file is the ruling, and the ruling is not
> the wiring.
>
> **What does not move.** The graph is still the one carrier, `status:blocked` stays retired, the
> purpose matrix stands as written, and discharge still only ever admits. What changes is that the
> per-child edge stops being something a planner may or may not think to write.
