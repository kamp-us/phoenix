---
id: 0004
title: Product DOs bootstrap as singletons; refactor to per-atom shards on demand
status: superseded
date: 2026-05-09
tags: [architecture, durable-objects, sozluk, pano]
---

Superseded by [0005](0005-product-dos-shard-by-coordination-atom.md).

# 0004 — Product DOs bootstrap as singletons; refactor to per-atom shards on demand

## Context

[ADR 0003](0003-pasaport-singleton-do.md) accepted Pasaport as a singleton DO,
arguing "one auth realm = one coordination instance" as a principled exception
to Cloudflare's [Rules of Durable Objects][rules]:

> *"Do not create a single 'global' Durable Object that handles all requests."*

Since 0003, two product DOs have shipped — `Sozluk` and `Pano` — both
addressed via `env.<NAMESPACE>.idFromName("kampus")`. They are also singletons.
The exception in 0003 was scoped to auth; product DOs were explicitly *not*
covered. We are repeating the documented anti-pattern across all three product
DOs.

We considered (B) sharding now, before more code is built, and (C) pivoting to
D1. Both have higher present cost than continuing the current pattern, and the
case for either rests on a problem we do not have at community scale (sustained
per-product write contention, hot-entity coordination needs, cross-product join
volume). The DO classes themselves are cheap to author — Sozluk and Pano were
each built in ~20 minutes — which dissolves the "work already done" argument
against eventual refactor.

[rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

## Decision

Extend the singleton-DO exception to all current product DOs (`Sozluk`, `Pano`)
on the same terms as Pasaport in [ADR 0003](0003-pasaport-singleton-do.md).
Treat this as a bootstrap pattern, not a long-term architecture.

Schema discipline that preserves the future-shard door:
- Sozluk: `term.id` / `term.slug` is the natural shard key. Every row in
  `definition` (and the future `definition_vote`) MUST carry `termId`.
- Pano: `post.id` is the natural shard key. Every row in `tag`, `comment`,
  and the future `post_vote` / `comment_vote` MUST carry `postId`.
- Cross-feature references to users (`authorId`) MUST stay denormalized with
  display fields (`authorName`) to avoid cross-DO calls on the read path.
  This holds whether the storage is one DO, many DOs, or D1.

New product DOs added later inherit this exception by default, on the same
terms, until this ADR is superseded.

## Consequences

### Immediate

- `Sozluk` and `Pano` continue as singletons. Votes and mutations land on top
  of the singletons; the singleton DO IS the materialized view (cross-product
  aggregates like "popular terms", "hot posts" are single SQL queries inside
  the DO).
- All product writes serialize through one DO instance per product, pinned
  to one CF colo. Acceptable at community scale.
- Cross-product reads (e.g. "user X's recent activity across sozluk + pano")
  require RPC fan-out across product DOs. Not in scope today.

### When to refactor

Trigger conditions — refactor any one product to per-atom shards when **any**
of these become true for that product:

1. Sustained write contention on the singleton (approaching the documented
   ~500–1,000 req/sec ceiling for that product specifically).
2. A hot entity emerges (one term, one post) where bursty writes — collaborative
   editing, live discussion threads — would benefit from per-entity isolation.
3. Per-entity isolation is required for compliance, moderation, or audit
   reasons (per-term encryption, per-post takedown isolation, etc.).
4. Operational pain: one product's DO failures or maintenance windows blocking
   all writes for that product.

D1 migration (separate decision, would supersede this ADR for the affected
product) when:

- Cross-product SQL joins become so frequent the RPC fan-out is the bottleneck.
- Multi-region read replication becomes a real UX requirement.
- The maintenance/ops cost of singleton DO storage exceeds the value of
  in-DO co-location.

### Refactor playbook — singleton DO → per-atom DOs

Concrete steps when a refactor trigger fires, illustrated for Sozluk
(Pano is the same pattern with `post` in place of `term`):

1. **New per-atom DO class.** Add `SozlukTerm extends DurableObject<Env>`
   with the same drizzle schema MINUS the `term` table — each instance IS
   a term. Replace the `term` table with a `term_meta` row (one row, holds
   slug/title/createdAt for THIS term). `definition` and `definition_vote`
   tables stay unchanged but no longer need `termId` (everything in the DO
   is for one term).
2. **Wrangler migration.** Add the new binding + `new_sqlite_classes:
   ["SozlukTerm"]` migration tag. Keep the old `Sozluk` binding for the
   migration window.
3. **Materialized view.** Add a `term_summary` projection in a new D1
   binding (preferred) or as a separate read-optimized DO. Schema:
   ```
   term_summary(slug PK, title, first_letter, definition_count,
                total_score, excerpt, top_definition_id,
                first_at, last_activity_at, last_edit_at)
   ```
   Plus a `sozluk_stats` row for global counters (total definitions,
   total authors). Indexes on `last_activity_at DESC`, `total_score DESC`,
   `first_letter`.
4. **One-shot data migration script.** Read every term from singleton
   `Sozluk` DO via `listAllTerms()`. For each term: instantiate the
   per-term DO, write its meta + definitions + votes via a new
   `seedFromSnapshot()` RPC. Also write the corresponding `term_summary`
   row. Maintain a `migrated_terms` set in the singleton DO so the script
   is resumable.
5. **Dual-write window.** Mutations write to BOTH old singleton AND new
   per-term DO + MV. Reads still come from the singleton. Validate with a
   periodic diff job.
6. **Flip reads.** `term(slug)` resolver now addresses
   `env.SOZLUK_TERM.idFromName(slug)`. `terms(sort, limit)` resolver reads
   from the MV. The singleton stops serving reads.
7. **Drop the singleton write.** Mutations only write to per-term + MV.
   Run for one full activity cycle to confirm no regressions.
8. **Decommission.** Remove the `Sozluk` binding via wrangler
   `delete_classes: ["Sozluk"]` migration tag. Drop the singleton's
   storage with `deleteAll()`.

The migration is mechanical because the schema's natural partition key
(`termId` / `postId`) is already aligned with the future shard. The new
work is the MV layer (D1 schema + dual-write + reconcile job), not the
data shape.

### Banned

- Adding a new product as a singleton DO without amending or superseding
  this ADR. Each new product MUST either (a) declare its singleton-DO
  exception in writing here, or (b) ship with the per-atom shard pattern
  from day one.
- Cross-DO foreign keys (DOs are storage-isolated; FKs would not be
  enforced anyway). Use the denormalize-author-fields pattern instead.
- Silent removal of `termId` / `postId` from product schemas. These are
  load-bearing for the future shard.

### When superseded

If/when the refactor lands for a specific product, write a follow-up ADR
documenting the migration for that product and either (a) mark this ADR
`superseded` if all product DOs have been refactored, or (b) leave this
ADR `accepted` and note in the new ADR which products it now covers.
