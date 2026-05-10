---
id: 0005
title: Product DOs shard by coordination atom from day one
status: accepted
date: 2026-05-09
tags: [architecture, durable-objects, sozluk, pano]
---

# 0005 — Product DOs shard by coordination atom from day one

## Context

Supersedes [0004](0004-product-dos-bootstrap-as-singletons.md).

ADR 0004 considered accepting singleton DOs as a bootstrap pattern for
`Sozluk` and `Pano`, with a documented refactor playbook for later. We
rejected that. Reasons:

- Cloudflare's [Rules of Durable Objects][rules] name *"a single 'global'
  Durable Object that handles all requests"* as an anti-pattern. Building
  on top of three of these compounds the debt — every new feature that
  lands on a singleton DO is more code to refactor later.
- DO classes are cheap to author (Sozluk and Pano were each built in
  ~20 minutes). The "we already shipped it" argument doesn't hold when
  rebuilding is a half-hour each.
- "Bootstrap then refactor" sets a bad precedent. Future product DOs would
  inherit the same exception, and the refactor never happens because the
  trigger conditions in 0004 are deliberately conservative.
- Doing it right now is cheaper than doing it right later.

[ADR 0003](0003-pasaport-singleton-do.md) for Pasaport is unaffected:
"one auth realm = one coordination instance" remains a principled
exception scoped to auth, *not* a precedent for product DOs.

[rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

## Decision

Product DOs shard by their natural coordination atom from day one.

- **Sozluk:** one DO per term, addressed by `env.SOZLUK_TERM.idFromName(slug)`.
  Each instance owns one term's `term_meta` row, definitions, and votes.
- **Pano:** one DO per post, addressed by `env.PANO_POST.idFromName(postId)`.
  Each instance owns one post's `post_meta` row, tags, comments, and votes.
- **Cross-entity reads** (lists, browse, popular, recent, search, alphabet
  pivot, global stats) are served by a **D1 directory + materialized view**
  written through on every mutation. Per-entity reads (term page, post page)
  still hit the per-entity DO directly.
- **Pasaport** stays as-is per [ADR 0003](0003-pasaport-singleton-do.md).
  The auth-realm exception does not extend to products.

New product DOs added later MUST shard by their coordination atom from
day one, with a D1 MV for cross-entity reads. No new singleton product DOs.

## Consequences

### Schema discipline

- Sozluk DO instance owns one term: `term_meta(slug PK, title, createdAt)`,
  `definition(id PK, authorId, authorName, body, score, createdAt, updatedAt)`,
  `definition_vote(definitionId, voterId, value, createdAt)` — composite PK
  `(definitionId, voterId)` for one-vote-per-user.
- Pano DO instance owns one post: `post_meta(id PK, slug, title, url, host,
  body, authorId, authorName, score, commentCount, createdAt, updatedAt)`,
  `tag`, `comment` (with self-ref `parentId`), `post_vote`, `comment_vote`.
- Author references stay denormalized (`authorName` on each row) — DOs are
  storage-isolated, FKs would not enforce.
- D1 MV holds the read-optimized projection for lists; see playbook.

### Refactor — current code (singletons → per-atom)

This is a "do it now" refactor for `Sozluk` and `Pano`. Steps:

1. **Rename / split DO classes.** `Sozluk` → `SozlukTerm`, `Pano` →
   `PanoPost`. Each instance now represents one entity.
2. **Schema delta inside the DO.** Drop the `term` (resp. `post`) table.
   Replace with a one-row `term_meta` (`post_meta`) table. Add `vote`
   tables. `definition.termId` (`comment.postId`, `tag.postId`,
   `post_vote.postId`) become unnecessary since the DO IS the partition;
   drop them in the new schema.
3. **Wrangler migration.** Add `new_sqlite_classes: ["SozlukTerm",
   "PanoPost"]` and `delete_classes: ["Sozluk", "Pano"]` in a new
   migration tag. Update bindings: `SOZLUK` → `SOZLUK_TERM`,
   `PANO` → `PANO_POST`.
4. **D1 binding.** Add a D1 binding (`PHOENIX_DB`) to wrangler. Schema:
   ```
   term_summary(slug PK, title, first_letter, definition_count,
                total_score, excerpt, top_definition_id,
                first_at, last_activity_at, last_edit_at)
   sozluk_stats(id=1 PK, total_definitions, total_authors, updated_at)
   post_summary(id PK, slug, title, host, score, comment_count,
                hot_score, author_id, author_name, created_at,
                last_activity_at)
   pano_stats(id=1 PK, total_posts, total_comments, total_authors, updated_at)
   user_votes(user_id, target_kind, target_id, value)  -- powers myVote
   ```
   Indexes on `last_activity_at DESC`, `total_score DESC` /
   `hot_score DESC`, `first_letter`, `host`.
5. **Resolver split.** Cross-entity reads (`terms(sort, limit)`, `posts(sort,
   limit, host)`) read directly from D1. Per-entity reads (`term(slug)`,
   `post(idOrSlug)`, `postComments(postId)`) RPC into the per-entity DO.
6. **Mutations dual-write.** Every write mutation: per-entity DO updates
   its own state atomically AND the resolver writes the new authoritative
   aggregates into the D1 MV. The DO returns canonical aggregates so the
   MV write is convergent (overwrites whatever was there), not incremental.
7. **Re-seed.** Existing seed data lives in the singletons today; on the
   refactor commit, drop the old seed call sites and re-seed by walking
   the seed array and invoking the per-entity DO + MV write paths. No
   user data exists yet, so no migration script needed.
8. **Validate.** Smoke-test reads (home, term page, pano feed, post page),
   writes (addDefinition, voteDefinition, addPost, addComment, vote
   variants) end-to-end. Confirm MV stays convergent across vote toggles.

### Failure modes to design for

- **DO write succeeds, MV write fails.** Cheapest mitigation: every DO
  mutation returns canonical aggregates; the MV write is a full overwrite.
  A periodic reconcile job walks `term_summary` rows older than N days and
  pulls fresh state from the corresponding per-term DO.
- **MV write succeeds, DO write didn't (rare with Workers' transactional
  semantics, but possible on partial failures).** Use the DO's RPC return
  value as truth — never write to MV from the resolver's intent, only from
  the DO's confirmed result.

### Banned

- New product features added to the existing singleton `Sozluk` / `Pano`
  DO classes. The refactor lands first.
- Any new product DO that is not sharded by its coordination atom on day one.
- Cross-DO foreign keys (DOs are storage-isolated; FKs would not be
  enforced anyway).
- Removing the D1 binding. The MV layer is part of the design, not optional.

### Out of scope

- Voting mechanics specifics (up-only vs up/down, weights, reputation) —
  decide separately when wiring vote mutations.
- Anti-abuse (rate limiting, vote manipulation, sockpuppets) — when votes
  are wired.
- Effect+RPC (spellbook port to v4) — plain DO methods stay; revisit if
  cross-DO RPC type-safety becomes painful.
- Search (FTS) — D1 supports FTS5; add when sozluk has enough content
  to make string search interesting.
