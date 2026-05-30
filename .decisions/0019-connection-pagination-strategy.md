---
id: 0019
title: Connection pagination — custom resolvers deliver every connection
status: accepted
date: 2026-05-23
tags: [fate, pagination, connections]
---

# 0019 — Connection pagination: custom resolvers deliver every connection

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
  `Profile.contributions`) resolve via the parent's custom `queries` resolver,
  which builds the `ConnectionResult` from the service keyset method. The view's
  `list(view, {orderBy})` must match the service's `ORDER BY` exactly, with `id`
  as the final tiebreaker, so the keyset cursors round-trip. *(See the 1.0.3
  amendment for why fate does not auto-invoke a source `connection` executor for
  a hand-built source, and the 1.0.4 amendment for the removal of those dead
  executors.)*

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

## 1.0.4 amendment — the source `connection` executors are removed

The 1.0.3 amendment established that the source `connection` executors are
unreachable for phoenix's hand-built sources, so the parent custom resolver is
the *only* path that delivers a nested connection. That left the
`Definition`/`Comment`/`Contribution` source `connection` executors (plus every
source `orderBy` contract) as dead code held in hand-maintained lockstep with
the service `ORDER BY` — a second copy of the keyset order that nothing
invoked.

**Those executors and the source `orderBy` declarations are now deleted**
(`worker/features/fate/sources.ts`). Only the parent resolver delivers a nested
connection; there is genuinely one keyset path (the service method). The
`Contribution` source — which had *only* a `connection` executor and no
relation `byId`/`byIds` — is removed entirely (the feed is delivered solely by
`queries.profile`). The `byId`/`byIds` executors stay: they back by-id reads
and live relation masking.

The lockstep `orderBy`↔`ORDER BY` invariant now has one home — the view's
`list(view, {orderBy})` mirroring the service `ORDER BY` — instead of being
duplicated a third time in the source definition.
