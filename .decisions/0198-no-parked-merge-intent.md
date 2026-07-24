---
id: 0198
title: "ship-it never parks a merge intent — an armed `--auto` is a transient artifact of a completed gate pass, cleared at every path that does not enqueue (closes the §CP approve-then-enqueue ordering hole)"
status: accepted
date: 2026-07-22
tags: [pipeline, ship-it, control-plane, merge-queue, security]
---

# 0198 — No parked merge intent: `--auto` never outlives the run that armed it

**What this decides:** ship-it keeps the ADR-0135 §CP enqueue primitive (`gh pr merge --auto`)
but adds a **lifecycle invariant** around it — an armed merge request may exist only between a
fully-gated Step-4 enqueue and the queue accepting the PR. Every other path (run start, any
STOP/refusal, a merge-queue ejection, an enqueue that did not take effect) **clears** it, verified
by an `auto_merge` read-back.

## Context

ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) split the §CP
merge into *human judgment* (the control-plane approval) and *pipeline mechanics* (the enqueue).
The mechanics half is not a formality: ship-it's enqueue step is exactly where the machine gates
are asserted **at that instant** — current-head-bound verdicts in every required namespace (ADR
[0058](0058-sha-bound-verdict-contract.md)), the SHA-bound run-evidence bundle (ADR
[0054](0054-run-evidence-bundle.md)/0056), the landed-comment leak scan, and zero substantive
unresolved review threads (ADR [0158](0158-unresolved-review-thread-is-a-merge-gate.md)).

**The hole: a merge intent survives the run that armed it.** `gh pr merge --auto` is a *durable
request*, not a one-shot action. When it does not take effect at the head it was made against —
because a requirement is unmet, or the run was interrupted mid-ship — GitHub keeps it armed, and
it fires the moment the last requirement lands. On a §CP PR that last requirement is the human
approval. So a §CP PR carrying a stale arm **enqueues the instant a fresh approval lands, with no
ship-it run in between**: the assertions above are skipped at the decisive instant.

Observed live on PR #3700 (2026-07-20, issue
[#3723](https://github.com/kamp-us/phoenix/issues/3723)): `added_to_merge_queue` fired **one second
after** the approving review, from an arm left by an earlier attempt that was interrupted by a
conflict-resolving rebase; the ship-it run that was supposed to gate the enqueue started afterward
and found the PR already queued. The concrete bad case the arm permits: a §CP PR that is enqueued,
ejected from the queue (the expected failure mode under concurrent merges — ADR
[0132](0132-merge-queue-for-base-freshness.md)), rebased, re-reviewed and re-approved
**re-enqueues on the re-approval alone** — even if the new head's run-evidence bundle is missing or
failing, or a leak landed in a verdict comment.

**Scope, stated precisely: this is an ordering/integrity defect, not an approval bypass.** The
human approval is still required and branch protection still enforces it (ADR 0135 / ADR
[0048](0048-ship-it-merge-actor.md)). What the stale arm defeats is the *sequencing* — the
guarantee that the enqueue happens **inside** a run that has just asserted the machine gates.

## Decision

**An armed merge intent is a transient artifact of a completed gate pass, never a durable state.**
The §CP enqueue primitive is unchanged (`gh pr merge --auto`, no method flag — the queue owns
SQUASH, ADR 0132); what changes is that no ship-it path may leave one parked. Four sites, one rule:

1. **Run start (`preflight`)** — clear any intent armed before this run's guards ran. An arm that
   predates the assertions is backed by no gate pass at this head; this is what catches the
   interrupted run (the #3700 mechanism), which by definition reaches no exit path of its own.
2. **Every STOP/refusal (`refuse`)** — the §CP `awaiting control-plane approval` stop, a
   current-head FAIL verdict, an unverified/stale verdict, a red or still-pending CI, a missing
   run-evidence bundle, a substantive unresolved thread, a landed-comment leak, a dropped-trigger
   nudge, and the Step-1 stops (draft, closed-unmerged, no linked issue). A run that declines to
   enqueue must not leave behind the means to enqueue without it.
3. **A merge-queue ejection (`ejected`)** — an ejected PR re-enters through a *fresh* ship-it gate
   pass, never by a surviving intent firing on the re-approval.
4. **After the bounded post-enqueue reconcile (`post-enqueue`)** — if a merge queue governs the
   base branch but the PR is not queued, the `--auto` did not take effect: what remains is a
   parked intent, not a queue entry.

**What is deliberately NOT touched: a live queue entry.** When the PR is in the merge queue,
ship-it never dequeues it — that entry *is* an authorized in-flight merge from a completed gate
pass, and the async merge is the queue's to finish (ADR 0132). Fighting the queue would be a
different decision; this one only refuses to *park* intent.

**The exemption that keeps `--auto` universal-safe, and the predicate it keys on.** Where **no
merge queue governs the PR's base branch** — the pre-queue regime ADR 0132's transition safety
preserves, and any foreign repo with no queue (ADR [0062](0062-repo-as-config-plugin.md)) — the
armed request *is* the sanctioned enqueue mechanism, so `post-enqueue` keeps it. The predicate is
deliberately a **property of the base branch, not of the PR**: it is read from the branch's active
rulesets (a `merge_queue` rule on `GET /repos/{repo}/rules/branches/{branch}`). A per-PR proxy —
"has the queue ever governed *this PR*?" — looks equivalent and is not: under a merge queue, a PR
on its **first** enqueue attempt has no queue history either, so the proxy would exempt exactly the
parked intent this ADR exists to clear (the state PR #3700 was in before its ungated enqueue). The
exemption is additionally scoped to that one site: at `preflight` the same arm is stale by
construction, in either regime.

**The decision is a tested function, and the clear is verified.** The branch lives in the pure core
of `pipeline-cli merge-intent` (`packages/pipeline-cli/src/tools/merge-intent/`), the single source
ship-it runs, so it cannot drift across shippers — the `cp-cardinality` (ADR
[0175](0175-cp-self-approval-cardinality-check.md)) / `merge-queue-classify` precedent. The verb
does not trust `gh pr merge --disable-auto`'s exit code, which is non-zero both when the disable
failed and when nothing was armed: it **re-reads `auto_merge`** and reports success only on a live
`null`, the same self-verify shape `verdict post` applies to a landed comment. An unprovable clear
fails **loud** (exit 1) rather than reporting a clean stop.

**Fail-closed direction — every read, in the direction of disarm.** An unreadable arm state
resolves to *disarm*. An unreadable base-branch regime resolves to *queue-governed*, so a failed
read can never reach the exemption's keep — the exemption is only ever taken on positive evidence
that no queue governs the branch. The asymmetry is deliberate: a needless disarm costs one
idempotent re-ship (every ship-it refusal is already re-dispatchable by construction), while a
surviving parked intent costs an ungated enqueue.

## Consequences

- **The enqueue is once again strictly downstream of the gate assertions.** On a queue-governed
  base branch — every PR in this repo — an approval can no longer, by itself, move a §CP PR into
  the merge queue: no ship-it path leaves an arm behind, so the approval is inert until a run
  asserts the current-head machine gates and enqueues. The ADR-0135 split (human judgment via the
  approval, mechanics via the enqueue) is restored in ordering, not just in name. Where **no**
  merge queue governs the base branch, the pre-queue exemption is in force by design and `--auto`
  remains the enqueue mechanism — that regime is out of this ADR's scope, not an unstated residual.
- **The eject → rebase → re-approve cycle re-enters through the gate.** The ejection clears the
  intent, so the re-approval cannot re-enqueue on its own; a fresh ship-it run re-asserts the new
  head's verdicts, run-evidence, leak scan and threads before the PR returns to the queue.
- **A stop is now provably a stop.** ship-it's refusals were already durable and PR-visible
  (#1928); they are now also *complete* — a refusal that cannot prove the intent is clear reports
  `failed`, so "ship-it declined" no longer silently means "ship-it declined, and armed the merge."
- **No new merge authority, no weakened guard.** ADR 0048's single-merge-authority is untouched
  (ship-it still owns the enqueue), 0135's approval gate is untouched, 0058's SHA-binding is
  untouched, and no existing refusal becomes an enqueue. The change only *removes* a path by which
  an enqueue could happen without a run.
- **Cost: two extra `gh` round trips per lifecycle site** (the merge state plus the base-branch
  regime probe), and a rare needless disarm on an unreadable read — recovered by an idempotent
  re-ship.
- **Banned:** leaving `--auto` armed on a PR a run declined to enqueue ("it can't merge without an
  approval anyway" — true about *merging*, false about *gating*, the exact #3700 reasoning);
  treating `gh pr merge --disable-auto`'s exit code as proof of the clear; dequeuing a PR that is
  live in the merge queue; extending the pre-queue exemption beyond the `post-enqueue` site; and
  re-keying that exemption onto a per-PR signal (queue history, arm age) instead of the base
  branch's regime.
- **Relationship.** Repairs the enqueue seam of [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
  without changing its approve-then-enqueue model or its primitive. Preserves
  [0048](0048-ship-it-merge-actor.md) (single merge authority) and
  [0132](0132-merge-queue-for-base-freshness.md) (the queue owns the async merge; a live entry is
  never disturbed). Extends [0058](0058-sha-bound-verdict-contract.md)'s "a moved head invalidates
  what was bound to the old one" from verdicts and approvals to the **merge intent** itself.
