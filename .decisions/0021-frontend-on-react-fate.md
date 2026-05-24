---
id: 0021
title: Frontend on react-fate — batched per-screen requests, declarative mutations
status: accepted
date: 2026-05-23
tags: [fate, frontend, react, relay]
---

# 0021 — Frontend on react-fate: batched per-screen requests, declarative mutations

## Context

The SPA's data layer is Relay: co-located fragments, `useLazyLoadQuery`,
`usePaginationFragment`, and `useMutation` with imperative `updater`s —
including a fragile pattern that enumerates `@connection` storage-key strings
by hand to prepend into filter-keyed feeds. [0015](0015-adopt-fate-native-protocol.md)
replaces the protocol; the client follows.

## Decision

The SPA's data layer is `react-fate`:

- Components declare co-located `view`s, read with `useView`; a screen root
  resolves the whole composed tree in **one batched `useRequest`**; child
  views read from cache (no waterfalls). `useListView` paginates.
- Mutations are `fate.mutations` / `fate.actions` with **declarative
  `optimistic`** and **`insert`/`delete`** for list membership — there are no
  imperative cache updaters. Membership beyond registered root lists is driven
  by server-emitted live events (see [0023](0023-live-views-sse-livedo.md)).
- One `<FateClient>` provider, keyed on user id so the cache resets on
  login/logout. Errors split into inline (`callSite`) vs thrown (`boundary`).

## Consequences

- **Easier:** no waterfalls, no hand-written store surgery, type-safe end to
  end, masking prevents accidental coupling.
- **Cost:** rewrite every Relay component and the non-Relay `gqlFetch` callers
  (`useMe`, username bootstrap). fate is alpha.
- **Banned:** Relay, imperative connection updaters, `gqlFetch`.
- See `.patterns/fate-client-setup.md`, `fate-views-and-requests.md`,
  `fate-mutations-client.md`.
