---
id: 0094
title: One app-lifetime global live pin replaces the per-view keep-alives — the transient-0-refcount teardown made unrepresentable
status: accepted
date: 2026-06-19
tags: [fate, live, sse, frontend]
---

# 0094 — App-lifetime global live pin

## Context

fate's native live client refcounts the one shared SSE `EventSource`: `remove()`
runs `if (operations.size === 0) { source.close(); nativeLiveClient = undefined }`,
and the next subscribe rebuilds a fresh stream with a new random `connectionId`.
A page whose only live subscription is a `useLiveListView` transiently
unsubscribes during the in-flight refetch a write mutation triggers (`useRequest`
hands the connection back as a bare array, no `ConnectionTag`, so the subscribe
effect re-keys on a now-null `metadata.key`). In that window the lone subscription
drops, `operations.size` hits 0, the stream closes, and the mutation's
fire-and-forget publish lands on the dead `connectionId` and is lost — the new
row never appears until a manual refresh ([#711](https://github.com/kamp-us/phoenix/issues/711);
root cause of [#708](https://github.com/kamp-us/phoenix/issues/708)).

The first in-repo mitigation ([#708](https://github.com/kamp-us/phoenix/issues/708))
was a pair of per-view keep-alive hooks (`useLiveKeepAlive` /
`useLiveListKeepAlive`) that each churning view mounted to hold a *second* stable
subscription. That worked but was a band-aid: every new churning view had to
remember to mount the matching pin on the right stable identity (parent ref vs
latched `listKey`), and a forgotten pin silently reintroduced the bug.

## Decision

Hold **one always-on live subscription for the entire authenticated session**, so
`operations.size` is structurally never 0 while the app is mounted. fate's
`source.close()` branch then cannot fire during mutation churn — the `EventSource`
+ `connectionId` stay stable and every publish reaches a live connection. The
transient-0-refcount state is made **unrepresentable** for every authenticated
live view at once.

- The pin lives in `apps/web/src/fate/useGlobalLivePin.ts` and is mounted once by
  `FateProvider`, above the router, inside the `FateClient` context, gated on a
  non-null session user id.
- The **anchor is the viewer's own `User` row**, keyed on the better-auth session
  id — always valid for an authenticated session (`User.id === CurrentUser.id`,
  the same id the `me` query resolves) and the lightest possible: a single
  entity-field subscription, no list/connection fan-out, no pagination churn.
- It **never fires for an anonymous client** (an anon `EventSource` 401-loops):
  the caller gates on `userId != null`. It releases on sign-out/unmount, so the
  stream tears down cleanly when the app leaves.
- The **per-view keep-alives are retired**: the global pin fully subsumes them
  (their sole job was preventing the same 0-refcount). `useLiveKeepAlive.ts` and
  its call sites in `SozlukTermPage`, `PanoPostDetail`, `PanoFeed`,
  `SavedPostsPage` are removed.

This is the real-consumer ([ADR 0091](0091-infra-epics-need-a-real-consumer.md))
of the live-substrate work — every authenticated live view rides it.

## Consequences

- A new churning live view needs **no** per-view pin; correctness is automatic
  while the authenticated session is mounted.
- **One persistent SSE connection per authenticated tab** for the session
  lifetime — expected, not a leak: the connection-role `LiveDO` is pinned in
  memory by an open stream regardless (`.patterns/fate-live-views.md` "On
  hibernation"), and a single held stream is exactly the design (one shared
  `EventSource` per client). It releases on sign-out/unmount.
- The transport-level invariant is unit-proved in
  `apps/web/src/fate/globalLivePin.test.ts`: with the pin held the `EventSource`
  is never closed across a view's unsubscribe+resubscribe churn; with the pin
  removed it is torn down (the falsification baseline).
- The **read-back self-heal** (`useReadbackRefetch`, [#714](https://github.com/kamp-us/phoenix/issues/714))
  is a *different* loss — the publish-vs-register race — and is untouched; the
  global pin addresses only the refcount teardown.
- Does **not** change the upstream fate behavior; it works within it. Removing the
  teardown-on-transient-0-refcount in fate itself remains a possible upstream
  improvement, but is no longer load-bearing for phoenix.
