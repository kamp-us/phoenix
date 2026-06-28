---
id: 0117
title: Denormalized Aggregate Stats Are Written at the Source-Mutation Site, Not Behind the Query Feature
status: accepted
date: 2026-06-28
tags: [stats, features, denormalization]
---

# 0117 — Denormalized Aggregate Stats Are Written at the Source-Mutation Site, Not Behind the Query Feature

## Context

The `sozluk_stats` and `pano_stats` single-row tables (landing totals — `total_definitions`/`total_terms`/`total_authors`, the pano equivalents) are **denormalized caches** of the live content. Their writes live inside the source-entity mutation paths of the owning product service, not in the `stats/` feature:

- `recomputeSozlukStats` (`features/sozluk/Sozluk.ts`) upserts `sozluk_stats` from the five definition-mutation paths (`addDefinition` / `deleteDefinition` / `restoreDefinition` / `moderateRemoveDefinition` / `moderateRestoreDefinition`), after the entity write, **outside** the cleanup batch (a recomputable cache refreshed outside the batch, the rationale the write-site comments cite as [ADR 0011](0011-drizzle-context-service.md)).
- `makePersistPanoStats` (`features/pano/pano-stats.ts`) upserts `pano_stats` from the ten post/comment-mutation paths — structurally identical (after the write, outside the batch). The only difference is file layout: pano extracts the funnel into an injectable port because its post/comment operations live in separate files; sözlük inlines it.

The `stats/` feature is strictly **query-only** — `Stats.getLandingStats` only SELECTs; there is no write to either `*_stats` table anywhere in the feature.

#866 raised this as a possible violation of ADR 0036's feature-grouping invariant — "the stats store has two owners." That premise rests on a misreading: [ADR 0036](0036-features-as-any-named-app-grouping.md) designates `stats/` as a **query-only feature folder** (the read surface it ships) and is **silent** on which service owns the *write* to a denormalized table. There is no invariant that a derived store's write must live behind the feature that reads it.

The fork: **(1)** move the write behind the Stats service so it is the single owner of both reads and writes of `*_stats`; or **(2)** keep the write at the source-mutation site and record it as a deliberate denormalization funnel.

## Decision

**(2), generalized to both `*_stats` funnels.** A denormalized aggregate store is **maintained inline by the owning product service at its source-mutation site** — refreshed after each write that can change the totals, outside the transaction/batch (a recomputable cache, ADR 0011). The `stats/` feature stays **read-only**: it reads the `*_stats` tables and never writes them.

This is the canonical shape for any derived/materialized aggregate in the worker, not a sözlük/pano special case. ADR 0036's "stats is query-only" describes the **read feature's surface**, not write-ownership of the derived table — the two are not in tension.

Why not (1):

- The write is **triggered by, and belongs with, the source-entity mutation** — it lives in the product service that owns the source data. Moving it behind Stats would force the query-only feature to own a write driven by another domain's mutations, **inverting the dependency** (Stats currently depends on nothing; product services own their own caches).
- The product service already owns the count queries — it knows what "a live definition / post" is (the same `publicLiveWhere` predicate the reads use, from the visibility seam). Relocating those into Stats would split that knowledge across two features.
- The current direction is the standard read/write split for a materialized view: the write side maintains the cache at the source; the read side serves it.

## Consequences

- **Legible owner, by side:** the *write* owner of a `*_stats` store is the product service at its mutation site (Sozluk / Pano); the *read* owner is the query-only `stats/` feature. The split is deliberate and now recorded, not accidental.
- **Generalizes:** any future denormalized aggregate follows the same shape — written at its source-mutation site by the owning service, read by a query-only feature. A new derived store must not put its write behind its reader.
- **Banned:** moving a `*_stats` write behind the `stats/` feature, or making `stats/` read-write. If a derived store genuinely has no single source-mutation owner (spans planes with no convergent write site), that is a *new* decision, not this shape.
- **No code move:** the current placement is already correct; the load-bearing comments at the write sites (`Sozluk.ts`, `pano-stats.ts`, citing ADR 0011) plus this ADR make it legible — so #866 closes on the recorded decision with no follow-on code-change issue.

Grounds the #866 decision. Does not supersede ADR 0036 (it answers a question 0036 never addressed) or ADR 0011 (it builds on the recomputable-cache rationale).
