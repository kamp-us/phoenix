---
id: 0096
title: A uniform soft-delete / removal substrate across all deletable content — reversible, audited, karma-kept
status: accepted
date: 2026-06-20
tags: [delete, moderation, karma, vote, pano, sozluk, domain-model]
---

# 0096 — A uniform soft-delete / removal substrate across all deletable content

## Context

Supersedes [0024](0024-delete-semantics-and-karma.md). That ADR recorded — and deferred — the divergence between the three delete paths; this one resolves it.

Today the three deletable entity types delete three *different* ways:

- **sözlük definitions** — SOFT: `deletedAt` set, filtered out, votes + karma kept (`apps/web/worker/features/sozluk/Sozluk.ts:729`).
- **pano posts** — HARD: row removed, `post_vote` + `user_vote` wiped, FTS row dropped, karma reversed (`MAX(0, total_karma - priorScore)`), one atomic batch (`Pano.ts:1180`).
- **pano comments** — reply-aware: soft `[silindi]` tombstone (`SILINDI_PLACEHOLDER`, `Pano.ts:61`) when it has live replies, else HARD; karma reversed either way (`Pano.ts:1448`).

So three axes diverge at once: strategy (soft vs hard), karma (kept vs reversed), and the *shape* of "deleted" (a `deletedAt` timestamp on definitions, a rewritten-body tombstone on comments, total absence on posts). Two forcing functions now make the divergence untenable, not merely untidy:

1. **Account deletion** ([0097](0097-account-deletion-anonymize-silinen.md)) and **moderation** ([0098](0098-moderation-role-resolution-lifecycle.md)) both need to *remove a piece of content and keep a record of why*. A hard delete cannot be moderated (nothing to point a resolved report at), cannot be appealed, and cannot be re-attributed to `@[silinen]`. They need a single removal primitive underneath them, not three.
2. **Künye karma-gating** (the forcing function ADR 0024 already named): once karma gates privileges, "karma earned by content that was later removed" must have one defined answer, not a per-domain coin-flip.

The maintainer has decided the direction: **keep-and-soft-delete everywhere, reversible and auditable** — the opposite of hard-delete. This ADR is the substrate that realizes it; the other two build on it.

## Decision

### 1. One removal primitive: soft-delete, for every deletable entity

`definition_view`, `post_summary`, and `comment_view` are **never hard-deleted by a user, an author, or a moderator**. Removal is always a soft-delete: the row stays, marked removed, filtered from public reads, fully restorable. Hard `DELETE` of a content row leaves the codebase as a user-reachable operation. (Physical purge, if ever needed for a legal erasure obligation, is a separate offline D1 script — never a runtime route, exactly as the seed routes were removed; out of scope here.)

### 2. Removal is a TYPE, not a nullable-flag soup

The lifecycle state of a deletable entity is modeled as a closed discriminated union in the domain, not as an ad-hoc reading of three independent nullable columns. The shape (Effect `Schema.Union` of tagged members — the repo's `Schema.TaggedErrorClass` discipline, grounded in effect-smol §"Error handling basics" / §Context.Service):

```
EntityLifecycle =
  | Live
  | Removed({ removedAt, removedBy, reason: RemovalReason })

RemovalReason =
  | AuthorDeletion           // the author deleted their own content
  | Anonymized               // swept by account deletion (ADR 0097)
  | Moderated({ reportId })  // removed by a moderator acting on a report (ADR 0098)
```

`Removed` is *uninhabitable without* `removedAt` + `removedBy` + a `RemovalReason` — there is no way to construct a removed entity that doesn't carry its audit. "Removed but we don't know by whom/why" is unrepresentable. A `Restore` transition takes `Removed → Live` and is only defined on `Removed`; restoring a `Live` entity does not typecheck. Exhaustive handling of the reason is via `Match.tagsExhaustive` (effect-smol `packages/effect/src/Match.ts:1095` — a missing case is a compile error), so adding a fourth `RemovalReason` later forces every call site to address it.

This domain type is the in-memory projection of three persisted columns on each of the three content tables — `removed_at` (timestamp, null = live), `removed_by` (the actor's `user.id`), `removed_reason` (the `RemovalReason` tag + its payload, e.g. the originating `report_id`). The existing `deleted_at` column **is** `removed_at` in the substrate vocabulary; the two new columns are added beside it. The domain object reconstitutes the union from the row; services never branch on the raw columns.

### 3. The single cleanup home: `Vote.clearTarget(kind, id)` — votes wiped, karma KEPT

ADR 0024 named `Vote.clearTarget(kind, id)` as the likely single cleanup seam. We land it — but with the karma rule resolved to **keep**:

- `Vote.clearTarget(kind, id)` removes the per-target vote rows (`definition_vote` / `post_vote` / `comment_vote`) and the `user_vote` mirror rows for that target, in **one batch** (ADR 0014), so a removed entity carries no orphan vote rows and can't be re-voted (`Vote.cast`'s `deletedAt IS NULL` guard already refuses a removed target — `Vote.ts`).
- It does **NOT** decrement the author's `total_karma`. **Karma earned stays earned.** Removing content — whether by the author, by account deletion, or by a moderator — never reverses the karma its upvotes earned. This is the sözlük rule, generalized; the pano karma-reversal is **deleted**.

Rationale for keep-not-reverse as the *correct* (not merely cheaper) rule: karma is a record of past community judgment, not a live function of currently-visible content. Reversing it on removal makes a user's karma silently mutable by a moderator's action or their own cleanup, creates a karma-vs-recomputed-score disagreement (ADR 0024's exact symptom), and — once künye gates privileges — turns "delete my old post" into "lose standing," a perverse incentive against cleanup. Keep is the rule that makes karma a stable credential. The score *cache* on the row (and `term_summary` / `pano_stats`) is recomputed to exclude the removed entity (recomputable caches, refreshed **outside** the cleanup batch — ADR 0011), but the author's karma total is untouched.

`Vote.clearTarget` is the one place vote-cleanup lives; the three inline batches in `Pano.deletePost` / `Pano.deleteComment` and the (absent) one in `Sozluk.deleteDefinition` collapse into a call to it.

### 4. Reversibility is real and tested

`Restore` is a first-class, tested operation, not a stub: it flips `removed_at` back to null, re-derives the score cache / summaries, and the entity is live again. Vote rows wiped by `clearTarget` are **not** resurrected — votes are not part of the reversible content; re-voting is the community's to redo. Restore brings back the *content and its authorship*, which is what reversibility means here. The integration tier (ADR 0082, real D1) asserts the full remove→restore round-trip for each of the three entity types.

### 5. Tombstone rendering stays a view concern

The `[silindi]` placeholder a removed-with-replies comment renders is a **presentation** of `Removed`, computed at the view/shaper layer from the lifecycle state, not a body the delete path writes into the canonical row. The substrate removes; the view decides how a removed entity reads in each surface (a thread shows `[silindi]` to preserve reply structure; a profile feed omits it; a moderator queue shows the original). This keeps the canonical body intact for restore and for the moderator's review.

## Alternatives rejected

- **Keep soft-vs-hard as deliberate per-domain choices (ADR 0024 option 1, status quo).** Rejected: it is the very divergence the two consumers can't build on. A moderator can't act on a hard-deleted post; account-anonymization can't re-attribute an absent row. Three primitives means each consumer special-cases all three — the combinatorial mess this repo exists to avoid.
- **Reverse karma on removal (the pano rule, generalized the other way).** Rejected on the merits above: it makes karma a mutable, moderator-pokeable number and punishes cleanup once karma is a gate.
- **A single `deleted` boolean / bare `deletedAt` everywhere (the "lighter" uniform option).** Rejected: it carries no actor and no reason, so it cannot be audited or moderated, and it re-creates the nullable-flag soup the type model exists to kill. The audit columns are not optional polish; they are what makes the substrate load-bearing for 0097 and 0098.

## Consequences

- **One removal primitive** underneath author-delete, account-deletion ([0097](0097-account-deletion-anonymize-silinen.md)), and moderation ([0098](0098-moderation-role-resolution-lifecycle.md)). None of them re-implements cleanup; all three call the substrate.
- **Karma is now stable across removal.** The pano karma-reversal batch (`Pano.ts:1180`, `Pano.ts:1448`) is deleted; sözlük's keep-rule becomes universal. ADR 0024's karma-vs-score disagreement is closed by construction.
- **Invalid states unrepresentable:** "removed without an audit trail," "restored a live entity," and "deleted-then-still-votable" are all untypeable. A new removal reason can't be added without `Match` forcing every site to handle it.
- **Migration cost:** a migration repurposes `deleted_at` as `removed_at` and adds `removed_by` + `removed_reason` to `definition_view`, `post_summary`, `comment_view`; backfills existing soft-deleted definitions/comments as `Removed(AuthorDeletion)` with `removed_by = author_id` (best available). Pano posts hard-deleted in the past are gone and cannot be reconstructed — acceptable: pre-substrate history is not auditable retroactively.
- **Hard delete is now banned** as a content operation. A reviewer who sees a `db.delete(...)` against a content table should reject it.
- **Surfaces touched:** `Sozluk.ts:729`, `Pano.ts:1180`, `Pano.ts:1448`, `Pano.ts:61` (placeholder → view layer), `Vote.ts` (new `clearTarget`), `apps/web/worker/db/drizzle/schema.ts` (`definition_view`/`post_summary`/`comment_view` + migration), the per-feature `shapers.ts`/`views.ts` (tombstone rendering), `Report.ts:66` (`assertTargetLive` reads `deleted_at IS NULL` → `removed_at IS NULL`, unchanged in spirit).
