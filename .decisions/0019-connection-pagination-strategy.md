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

- **Easier:** root lists keep full pagination control; nested lists get fate's
  built-in keyset handling.
- **Harder:** nested-connection service methods must page by the fate keyset
  (the `orderBy` field values), not their natural-key cursor; the view
  `orderBy` and the service `ORDER BY` must stay in lockstep or pages skip or
  duplicate. Decide multi-key sorts (`popular`/`hot`) carefully.
- See `.patterns/fate-connections.md`.
