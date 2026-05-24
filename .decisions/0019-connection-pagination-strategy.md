---
id: 0019
title: Connection pagination — custom list resolvers for roots, source connection for nested
status: accepted
date: 2026-05-23
tags: [fate, pagination, connections]
---

# 0019 — Connection pagination: custom list resolvers for roots, source connection for nested

## Context

The feature services already implement keyset pagination, returning page
shapes (`{rows, hasNextPage, endCursor, totalCount}`) with cursors encoded as
the row's natural key. fate offers two ways to deliver a connection, and their
cursor encodings differ: a custom `lists` resolver returns a `ConnectionResult`
directly, while a source `connection` executor lets fate own keyset cursors
derived from the view's `orderBy`.

## Decision

- **Root lists** (`terms`, `posts`) resolve via custom `lists` resolvers that
  map the service page onto a `ConnectionResult`. The service owns the cursor
  and the keyset SQL.
- **Nested connections** (`Term.definitions`, `Post.comments`,
  `Profile.contributions`) resolve via the source `connection` executor. The
  view's `list(view, {orderBy})` must match the service's `ORDER BY` exactly,
  with `id` as the final tiebreaker, so fate's keyset cursors round-trip.

## Consequences

- **Easier:** root lists keep full pagination control; nested lists keep the
  keyset in the service.
- **Harder:** the view `orderBy` and the service `ORDER BY` must stay in
  lockstep or pages skip or duplicate. Decide multi-key sorts
  (`popular`/`hot`) carefully.
- See [fate-connections.md](../.patterns/fate-connections.md).

## 1.0.3 amendment — nested connections are delivered inline by the parent resolver

The original decision assumed fate auto-invokes a nested relation's source
`connection` executor and owns a keyset cursor derived from the view `orderBy`.
**That is not how `@nkzw/fate@1.0.3` behaves for a hand-built (non-Drizzle)
source resolver** (verified against the package): `resolveSourceConnection` is
only reached from the root `list` operation and from the banned Drizzle
adapter; the native path merely *re-shapes* a `list()` field the parent row
already carries (`arrayToConnection`), and the connection-node cursor is the
node **`id`**, not the `orderBy` field values.

So nested connections (`Term.definitions`) are delivered by the **parent custom
resolver**, which builds a pre-built `ConnectionResult` from a service keyset
method (`Sozluk.listDefinitionsKeyset`) keyed on the definition `id` in the
view's declared order. The DB keyset, the lockstep `orderBy`↔`ORDER BY` rule,
and the `id` tiebreaker all stand; only the *delivery mechanism* changed. Root
lists are unaffected (custom `lists` resolvers, as decided). Source authoritative
(CLAUDE.md): the pattern doc [fate-connections.md](../.patterns/fate-connections.md)
carries the corrected mechanics.
