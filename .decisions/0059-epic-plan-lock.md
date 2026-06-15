---
id: 0059
title: The epic-plan lock — one mutator at a time over an epic's children, plus a signature-keyed convergence checkpoint
status: accepted
date: 2026-06-14
tags: [pipeline, skills, plan-epic, review-plan, write-code, concurrency, agents]
---

# 0059 — The epic-plan lock — one mutator at a time over an epic's children, plus a signature-keyed convergence checkpoint

## Context

The plan layer has **no mutual exclusion over an epic**. Two distinct stages mutate one
epic's children and nothing serializes them (#264):

- **`review-plan` owns the `status:planned → status:triaged` flip** — the *only* thing that
  makes a child `write-code`-pickable (ADR [0047](0047-review-plan-gate.md);
  [gh-issue-intake-formats.md](../.claude/skills/gh-issue-intake-formats.md) §Pipeline labels).
- **`plan-epic` owns supersede/unlink/close on re-plan** — a re-plan can drop a child out
  from under that flip (plan-epic/SKILL.md §Re-plan).

Two concrete cross-skill races follow, both invisible to a single-skill view:

- **X3 (flip vs. supersede).** `review-plan` flips child C `planned → triaged` (pickable) at
  the same instant a concurrent `plan-epic` re-plan decides C is **superseded** and
  unlinks/closes it. A `write-code` agent picks C in the gap and **implements a story the
  plan just dropped** — the ledger and the live issue graph disagree, and `write-code` builds
  against the disagreement.
- **X4 (duplicate re-plan + count-only stall-detect).** `review-plan`'s convergence loop calls
  `rePlan(epic)` → spawns `plan-epic`. **Two** convergence loops on one epic spawn **two**
  concurrent `plan-epic` runs, each `PATCH`-ing the epic body (the lost-update of #261) and
  each producing a *different* ledger. If a stall/converge test keyed on defect **count**, two
  runs could land on the same count over a ledger the other corrupted and both "converge."

The plan ledger + child labels are the sole driver of what becomes pickable. Without
epic-level serialization, autonomous re-planning and gate-flipping on one epic produce a
ledger that contradicts the issue graph. This is the same last-write-wins family as the
issue-claim TOCTOU ([0058](0058-sha-bound-verdict-contract.md) lineage / §7, #260) and the
epic-body lost-update (#261) — but one layer up, over the *whole epic's child set*, not a
single field.

## Decision

**Only one of `{plan-epic, review-plan}` may mutate a given epic's children at a time.** A
`status:planning` lock label on the epic serializes them; a second mutator that finds the
lock held **backs off / parks** rather than interleaving. The convergence loop's
checkpoint keys on the ledger **signature (content hash)**, not defect count. Three coupled
rules:

### 1. `status:planning` is an epic-level lock, acquired before the first mutation

A mutator (`plan-epic` on any run, `review-plan` before its gate flip or its first `rePlan`)
**acquires the lock first**: re-read the epic's labels, and if `status:planning` is absent,
`POST` it; if present, **back off** (don't mutate) — the epic is being planned by another
run. The lock is **held until PASS-or-park** and then released (`DELETE` the label) on every
exit path, including failure.

- A `plan-epic` run that finds the lock held **defers** — it does not re-plan a body another
  planner is actively rewriting.
- A `review-plan` run that finds the lock held **does not flip and does not start its
  convergence loop** — it parks/backs off, because a concurrent `plan-epic` may be
  superseding the very children it would flip (this is the X3 serialization).

### 2. Honest residual — this is detect-and-serialize, not a kernel mutex

GitHub's `PUT .../labels` (set) and `POST .../labels` (add) are **not** compare-and-swap —
there is no conditional/`If-Match` label write. So a read-absent → `POST` acquire is a
**TOCTOU**, exactly like the issue-claim race (§7, #260): two mutators that both read the
lock absent in the same window both `POST` it and both proceed. The lock therefore
**narrows the window**, it does not eliminate it:

- The acquire is a **detect-and-back-off**, the same discipline #260 settled — re-read just
  before acquiring, defer to a lock already held, and treat your own `POST` echo as a detector
  (it reveals you may be racing), not a resolver.
- A true single-writer guarantee on one epic would need a **designated single planner** or a
  CAS the label API doesn't offer. We do **not** claim that. We claim: the *common* concurrent
  re-plan / flip-vs-supersede interleaving is serialized, and the residual co-acquire window is
  **narrowed**, not eliminated. Be precise about *which* residual each backstop covers: the
  #261 body-guard catches the epic-body **lost-update**, and the rule-3 signature checkpoint
  catches **false-convergence** (X4's count cycle). Neither backstops the **flip-vs-supersede
  invariant** of X3 (a superseded child C not left `status:triaged`): that invariant holds only
  on the serialized path — if both mutators co-acquire in the residual window, `review-plan`
  can still flip C `triaged` while `plan-epic` supersedes it, and nothing here catches it. The
  lock narrows that window; it does not close it, and X3 has no separate backstop.

This is the same honesty the issue-claim semantics (§7) and the SHA-bound verdict contract
([0058](0058-sha-bound-verdict-contract.md)) state for their own last-write-wins primitives:
detect-and-serialize, not a guarantee the API can't provide.

### 3. Convergence checkpoint keys on the ledger signature, not defect count

The re-plan convergence loop (`@phoenix/epic-ledger`'s `runConvergenceLoop`) already carries
the gate's run-stable `ledgerSignature` across iterations and parks on a **repeated
signature** (cycle) — the content-keyed stall test, *not* a count test (ADR
[0047](0047-review-plan-gate.md) Decision 3; `packages/epic-ledger/src/gate.ts`,
`loop.ts`). This ADR pins that the **convergence/stall decision is signature-keyed** as a
plan-layer contract a future change must preserve: a count-only check could declare
convergence on a ledger a concurrent run mutated (X4). The stall test is therefore
**content-keyed, not count-keyed** — the loop parks on a *repeated* signature (a cycle),
not on a count two runs happened to share.

Be precise about what the loop does and does not implement today (`loop.ts`): it compares
the current FAIL signature to the *previous* one and parks on a **repeat**. It does **not**
abort on arbitrary mid-loop drift — a *different* signature reads as progress and the loop
continues. The defense against a concurrent mutator drifting the ledger out from under a
running loop is the **lock (rule 1)**, not an in-loop drift check: the lock stops **two**
convergence loops from running at all — only one holder mutates, so only one loop drives an
epic. The signature checkpoint's job is narrower: it is the **cycle/false-convergence** guard
(a count-only test could converge on a corrupted-but-equal count; a repeated signature can't
be faked into looking like shrinking progress). A true "park on unexpected drift" checkpoint
(compare what the loop last drove the epic to vs. what it now reads) is **not** implemented
here; if that behavior is wanted it is a separate `loop.ts` change.

## Consequences

- **X3 closed on the serialized path (not separately backstopped).** A re-plan that supersedes
  child C holds the lock, so a concurrent `review-plan` finds it held and does **not** flip C
  `planned → triaged`. On the serialized path C is never left `status:triaged` (pickable) after
  it has been superseded/unlinked — the flip and the supersede are serialized, so `write-code`
  can't pick a dropped story. The flip-vs-supersede invariant holds **only** on that serialized
  path: in the residual co-acquire window (rule 2) both can still proceed, and **neither**
  backstop covers it — #261 guards the body lost-update, the signature checkpoint guards
  false-convergence, and a superseded child *can* still be momentarily left `triaged` there.
  The lock narrows that window; it does not eliminate X3.
- **X4 closed (primary path).** Two convergence loops can't both run: the second finds the
  lock held and backs off. The signature-keyed checkpoint is the backstop for false-convergence
  — keying the stall test on a *repeated* signature (a cycle), not a count two runs happened to
  share, so a count cycle over corrupted-but-equal content can't masquerade as convergence. (It
  parks on a repeat; it does not abort on arbitrary drift — see rule 3.)
- **Layering with #261 (don't conflate them).** This lock is the **primary serialization** —
  it prevents the concurrent re-plans at the *root*, so the body-write rarely races at all.
  #261's **surgical splice + optimistic recheck** on plan-epic's epic-body `PATCH`
  ([gh-issue-intake-formats.md](../.claude/skills/gh-issue-intake-formats.md) §1 "Updating it
  safely"; plan-epic/SKILL.md Step 5) is the **complementary backstop** for the residual
  co-acquire window of rule 2 **and** for body edits that aren't plan-epic re-plans (a handoff
  note, a manual edit). The two compose: lock = primary (no concurrent re-plans), splice+recheck
  = backstop (no silent lost-update if one slips through). Neither replaces the other; do not
  remove or duplicate the #261 body-guard.
- **Honest residual, stated.** The lock is window-narrowing detect-and-serialize, not a mutex
  (rule 2). The residual co-acquire window is real, and the backstops are **partial**: the #261
  body-guard catches the body **lost-update** and the signature checkpoint catches
  **false-convergence**, but the X3 **flip-vs-supersede** invariant is *not* separately
  backstopped — it holds only on the serialized path. The residual is narrowed, not closed.
- **New label.** `status:planning` joins the `status:*` family
  ([gh-issue-intake-formats.md](../.claude/skills/gh-issue-intake-formats.md) §Pipeline
  labels). It is a **transient lock**, *not* a pipeline-state label — it does not change what
  `write-code` picks (`write-code` keys on `status:triaged`), and it is always paired with the
  epic's real `status:*`, never replacing it. It is released on every exit path.
- **New cost.** Each mutator makes one extra labels read (acquire-check) and two extra label
  writes (acquire `POST`, release `DELETE`). A transient lookup failure fails closed → back off
  → re-run resolves it, consistent with #260/#261/0058.
- **Relationship.** Sits over [0047](0047-review-plan-gate.md) (the gate flip it serializes)
  and plan-epic's re-plan path; is the epic-child-set analogue of the issue-claim
  detect-and-tiebreak (§7, #260) and the epic-body splice+recheck (#261); shares the
  last-write-wins honesty of [0058](0058-sha-bound-verdict-contract.md). As a
  `.claude`/`.decisions` control-plane change, this ADR and its skill edits are
  **human-merged** per ADR [0053](0053-control-plane-boundary.md); the pipeline does not
  self-merge changes to its own plan-layer contract.
