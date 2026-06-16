---
id: 0050
title: Künye v1 karma stays D1-direct; KarmaBump contract unchanged
status: accepted
date: 2026-06-13
tags: [karma, kunye, durable-objects, vote, d1]
---

# 0050 — Künye v1 Karma Stays D1-Direct; KarmaBump Contract Unchanged

## Context

The künye epic (per-user reputation: karma, invites, agent identity, privilege
gates) needs one keystone decision before any of it is built: **does v1 karma
move to a per-user `KUNYE` Durable Object, or stay on the D1-direct
`user_profile.total_karma` column?** Everything downstream — the invite tree,
ban pruning, agent identity, karma-gated privileges — sits on whatever this
resolves. It is Phase 1; it gates the rest.

The decision is constrained by two prior ADRs:

- **[0009](0009-d1-direct-defer-dos-and-workflows.md)** (accepted) made D1 the
  single authoritative store and **banned adding a Durable Object "without a
  follow-up ADR that explicitly re-introduces the pattern, scoped to a named use
  case (real-time fan-out, hot-row contention, cross-aggregate atomicity)."** It
  ripped out ~2400 lines of DO + outbox + workflow code precisely because the
  cross-DO mutations künye *would* need did not yet exist. Its stated default:
  "the simplest path that ships the product."
- **[0008](0008-mutations-as-workflows.md)** (superseded by 0009) flagged its
  cross-aggregate workflow/DO pattern for re-adoption **"scoped to the
  cross-aggregate set (e.g. Künye _v2_ invite-spend) when that pressure
  returns."** The line between v1 and v2 was drawn there: the cross-aggregate
  atomicity pressure that justifies a DO is a **v2** invite-spend concern, not v1
  karma.

The current write path — the thing a DO would replace:

- A vote is **one atomic D1 batch**. `Vote.cast` folds four statements into
  `db.batch([...])` — vote-table upsert/delete, score-cache update, `user_vote`
  mirror, and the karma bump — committing all-or-nothing
  (`apps/web/worker/features/vote/Vote.ts`; atomicity per
  [0014](0014-drizzle-run-batch-as-service-methods.md)).
- Karma enters that batch through the **`KarmaBump`** contract
  (`apps/web/worker/features/vote/Vote.ts`):
  `statement(db, userId, delta) => Stmt` returns an *unexecuted* Drizzle batch
  item, satisfied at layer composition by pasaport's `karmaBumpStatement`
  (`UPDATE user_profile SET total_karma = total_karma + :delta`,
  `apps/web/worker/features/pasaport/karma.ts`). Its own docblock already names
  it "the swap point for a future DO-backed Künye karma bump — if that can't be
  expressed as a D1 batch statement, this contract is the thing to renegotiate."
- Karma also moves on content deletion (Pano hard-delete decrements
  `MAX(0, total_karma - priorScore)` in its own batch). That delete/karma
  asymmetry is the open question of
  [0024](0024-delete-semantics-and-karma.md) (proposed) and its successor #141 —
  a **separate** decision from this one.

Cloudflare's execution model has **no D1+DO atomic transaction**, and the
codebase has no existing D1+DO co-write: the one cross-store side-effect (LiveDO
fan-out, [0037](0037-unified-void-aligned-live-do.md)) is *detached*
fire-and-forget via `waitUntil` ([0041](0041-fate-bridge-worker-managed-runtime.md)
— CF isolates have no shutdown hook). A DO-backed karma bump therefore could not join
the vote's atomic batch; it would become an eventually-consistent write that can
be lost if the worker dies between the D1 commit and the DO RPC.

## Decision

**v1 künye karma stays D1-direct. No `KUNYE` Durable Object is introduced for v1.
`user_profile.total_karma` remains the canonical store.**

This is *not* the follow-up ADR that 0009 requires to add a DO — it is the
opposite: a recorded finding that v1 karma meets none of 0009's named pressures.

1. **Write path — D1-direct.** Karma is a single per-user integer maintained by
   inline `+delta` / `-delta` D1 updates inside the existing vote (and delete)
   batches. None of 0009's three DO-justifying pressures hold for v1 karma:
   - *Hot-row contention* — no. The write is
     `SET total_karma = total_karma + :delta`, an inline increment with no
     read-modify-write window; concurrent votes on the same author cannot lose
     increments. D1 serializes them.
   - *Cross-aggregate atomicity* — not in v1. v1 karma is one counter per user.
     The cross-aggregate operation (invite-spend: atomically debit one user's
     invite and mint another's identity; ban-pruning: cascade down an invite
     tree) is **künye v2**, exactly as 0008's re-adoption flag scopes it.
   - *Real-time fan-out* — no. Karma display is not real-time-critical; LiveDO
     (0037) already owns the one fan-out use case.
   - Moving karma to a DO in v1 would *regress* the path's strongest property —
     the atomic vote batch — to pre-build for a v2 feature whose shape isn't
     settled. That is the speculative-DO complexity 0009 removed.

2. **`KarmaBump` contract — unchanged.** It keeps its current shape:
   `statement(db, userId, delta) => Stmt`, an unexecuted Drizzle batch item
   folded into `Vote.cast`'s `db.batch([...])`. **The atomicity boundary is that
   single D1 batch:** the karma adjustment commits or rolls back as one unit with
   the vote-table, score-cache, and `user_vote` mutations. Because karma stays
   D1-direct, a vote spans **no** store boundary in v1 — there is no D1+DO seam to
   reason about.

   *The v2 boundary, named now so v2 doesn't re-derive it:* when künye v2
   invite-spend introduces a `KUNYE` DO (the re-adoption 0008 anticipates), karma
   can no longer be a batchable D1 statement. The contract is then renegotiated to
   **effect-after-commit** — the D1 batch (vote + score + `user_vote`) commits
   first and *is* the durability point; the DO karma write becomes an idempotent,
   retriable effect keyed by vote id, dispatched after commit (the `waitUntil` +
   idempotency-key pattern, since CF offers no cross-store transaction). The
   atomicity boundary then lands at the D1 commit, with the DO write
   reconciled-not-transacted. **That renegotiation is v2's ADR to write, not this
   one's** — v1 does not touch `KarmaBump` or Vote's internals.

3. **`total_karma` — canonical, read path unchanged.** The column stays the
   source of truth; it is not dropped and not demoted to a DO-written projection.
   The read path is unchanged: `Pasaport.lookupProfile` / `lookupProfileById`
   select `total_karma` → the `Profile` fate data view (`ProfileView.totalKarma`)
   → `apps/web/src/components/profile/UserProfileHeader.tsx` renders it. No
   read-model split, no projection layer, no new consumer.

Out of scope (unchanged by this decision): the new `KarmaBump` *implementation*
(there is none for v1 — the existing one stands); the delete/karma semantics of
[0024](0024-delete-semantics-and-karma.md) / #141 (D1-direct karma supports either
resolution — keep-on-delete and reverse-on-delete are both plain D1 updates); the
künye "reputation DO" framing in #41 — this ADR is where that question is answered
for v1, and the answer is no DO.

## Consequences

- **Easier:** the whole künye v1 epic builds on the existing, tested vote/karma
  path — no new DO class, no binding wiring in `worker/index.ts` /
  `alchemy.run.ts`, no per-user DO instance to provision or bill. New non-vote
  karma sources (e.g. invite bonuses) are additional D1 `UPDATE user_profile`
  statements; karma-gated privilege checks (#150) read the column they already
  read.
- **Preserved:** the vote's all-or-nothing atomicity. No eventual-consistency
  window is introduced in v1; karma cannot drift from the vote that caused it.
- **Deferred, with a clean seam:** the `KUNYE` DO is a **v2 invite-spend**
  decision. When that pressure arrives it gets its own ADR (satisfying 0009's
  follow-up requirement), and `KarmaBump` is the single, already-marked
  renegotiation point — Vote's internals don't change, only the contract's
  implementation does. This ADR makes that boundary explicit so v2 inherits it
  rather than rediscovering it.
- **Still banned (0009 stands):** adding any Durable Object — including a `KUNYE`
  DO — without its own scoped follow-up ADR. This ADR does not authorize one; it
  records that v1 doesn't need one.
- **Unblocks:** the karma-write-path implementation children (#149 and the stories
  that build on it) proceed against D1-direct with the contract fixed.
- **No migration cost.** Nothing moves; `total_karma` keeps its current shape and
  data.
