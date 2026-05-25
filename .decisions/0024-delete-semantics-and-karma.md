---
id: 0024
title: Entity-delete semantics and karma treatment
status: proposed
date: 2026-05-24
tags: [delete, karma, vote, pano, sozluk]
---

# 0024 — Entity-delete semantics and karma treatment

## Context

A thermo-nuclear code-quality review and the `2026-05-24` architecture audit
(candidate 1) surfaced an unrecorded inconsistency between the two delete paths
in the Effect feature services:

- **Pano `deletePost`** (`apps/web/worker/features/pano/Pano.ts:1191`) is a
  **hard** delete: it removes the `post_summary` row, wipes `post_vote` +
  `user_vote`, and **reverses the author's karma**
  (`totalKarma = MAX(0, totalKarma - priorScore)`) — all in one atomic batch.
- **Sozluk `deleteDefinition`** (`apps/web/worker/features/sozluk/Sozluk.ts:999`)
  is a **soft** delete: it sets `deletedAt`/`updatedAt`, recomputes the term
  summary + sözlük stats, but leaves `definition_vote`/`user_vote` intact and
  **never reverses the author's karma**.

So two axes diverge: the delete **strategy** (soft vs hard) and the **karma
treatment** (kept vs reversed). Consequence: deleting a definition keeps the
karma its upvotes earned, while deleting a post reverses it; a term's recomputed
score (which excludes soft-deleted definitions) can therefore disagree with the
author's karma total. `Vote.cast` already blocks voting on soft-deleted
definitions (`isNull(deletedAt)`), so the gap is **not exploitable** for fresh
karma — it is a consistency/semantics question, not an open abuse vector.

## Decision

**Deferred.** No change now. The asymmetry is an **accepted known
inconsistency** until the post-fate deepening effort decides it, together with
audit candidate 1 (deepening `Vote`'s interface). The open questions:

1. **Strategy** — converge on one delete strategy, or keep soft (sözlük) vs hard
   (pano) as deliberate per-domain choices?
2. **Karma** — should removing your contribution reverse the karma its votes
   earned? (Pano says yes; sözlük says no.)

The likely vehicle is a `Vote.clearTarget(kind, id)` method that wipes the
per-target vote table + `user_vote` + the karma decrement in one batch, giving
delete-cleanup one deep home instead of the current inconsistent inline batches
(see [0016](0016-fate-pure-transport-effect-services-domain.md) — domain logic
belongs in the service). The Künye karma direction is the forcing function:
once karma gates privileges, "karma from deleted content" needs a defined
answer.

## Consequences

- **Until decided:** author karma may include value from soft-deleted
  definitions; the two delete paths stay divergent. Anyone touching either
  delete path should read this ADR before "fixing" one to match the other —
  the divergence is known, not accidental.
- **When decided:** this ADR is superseded by the deepening decision, which
  should state the canonical delete strategy + karma rule and (if `clearTarget`
  lands) record the single cleanup home.
- No migration cost incurred now.
