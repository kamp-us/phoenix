---
id: 0125
title: Optimistic reconciliation for live-driven nested connections — client-append add-dedup + reply-aware delete
status: accepted
date: 2026-07-02
tags: [fate, live, optimistic, frontend]
---

# 0125 — Optimistic reconciliation for live-driven nested connections

## Context

Resolves decision [#1674](https://github.com/kamp-us/phoenix/issues/1674) (epic
[#1637](https://github.com/kamp-us/phoenix/issues/1637)). **Engineering-led v1 per
ADR [0078](0078-product-driven-decisions-by-default.md) — the fate substrate is
platform, so engineering leads — but a recommended default OPEN TO maintainer
(umut) override.** The `A2`/delete-readback escalations below are named so the
override has somewhere to land.

Epic #1637 makes content mutations optimistic. Three of its four mutation classes
already have a first-class fate mechanism; **nested-connection add/delete does
not**, and that is the fork this ADR closes for `comment.add` / `definition.add`
(inserts into `Post.comments` / `Term.definitions`) and `comment.delete` /
`definition.delete`.

Why nested is the hard case — grounded in the fate client source (`@nkzw/fate@1.3.1`,
`lib/`; seams `resolveOptimisticEntity`, `replaceListEntityId`, `insertConnectionEdge`,
`removeEntityFromListState`, `registerRootList`, `filterConnectionArgs` all verified
present) and the worker live-push sites:

- **fate's declarative `insert`/`delete` reach only *registered root lists*.**
  `registerRootList` is gated on `!filterConnectionArgs(argsPayload)` — a *nested*
  connection (`Post.comments` carried on the `post` query, `Term.definitions` on the
  `term` query) is never a root list, so client `insert`/`delete` **cannot touch
  it** ([.patterns/fate-mutations-client.md](../.patterns/fate-mutations-client.md)).
  Class B (`post.submit`/`post.delete` into the pano feed, a root list) rides
  `insert`/`delete`; nested add/delete has no equivalent.
- **Nested membership is server-driven.** The mutation publishes
  `live.topic("Post.comments",{id}).appendNode/deleteEdge` (or a `[silindi]`
  tombstone via `live.update`), and every subscribed client — the author included —
  merges the frame ([.patterns/fate-live-views.md](../.patterns/fate-live-views.md);
  `worker/features/pano/mutations.ts` §comment.add/delete,
  `sozluk/mutations.ts` §definition.add/delete).

Four forces make a naive optimistic node wrong:

1. **Double-append on add.** An optimistic temp node uses a temp id
   (`optimistic:${Date.now()}`); the server `appendNode` frame carries the *real*
   id. fate dedups edges by **canonical entity id** (`insertConnectionEdge` calls
   `removeEntityFromListState(listState, entityId)` before every insert;
   `live:{append:"visible"}` short-circuits an already-visible id). So dedup fires
   **only once the temp id is rewritten to the server id** — which happens in
   `resolveOptimisticEntity(tempId, serverId)` → `store.replaceListEntityId(...)`
   when the **mutation HTTP result** returns. If the SSE `appendNode` (server id)
   lands *before* the HTTP result resolves temp→server, temp-node and server-node
   coexist → **double**. This is exactly the failure the pattern doc cites when it
   forbids an optimistic temp-node here.
2. **Reply-aware delete: leaf-`deleteEdge` vs `[silindi]`-tombstone.**
   `comment.delete` is *not* a simple removal (ADR
   [0096](0096-uniform-soft-delete-substrate.md)): a **leaf** publishes `deleteEdge`
   (row drops); a comment **with replies** stays as a `[silindi]` tombstone via
   `live.update({changed:["body","deletedAt",…]})` — the edge must **not** leave the
   connection or the subtree orphans. An optimistic **hard-remove is wrong for the
   tombstone case.** (`definition.delete` has no reply tree — it *always*
   `deleteEdge`s — so it's the easy sibling.)
3. **No-divergence guarantee.** The rule that optimistic state and SSE-reconciled
   state never disagree: no phantom row (rollback missed), no double row
   (temp+server), no stale tombstone.
4. **Interaction with `useReadbackRefetch`.** The add path today is *non-optimistic*
   and leans on `useReadbackRefetch` (`decideReadback` core) to heal a **lost**
   append ([#714](https://github.com/kamp-us/phoenix/issues/714): the fire-and-forget
   publish races the subscriber `register` and frequently delivers to nobody — the
   append is *lost, not late*). Any strategy must say whether readback is
   kept/narrowed/replaced, because "the append can just never arrive" is the normal
   case under load, not an edge case.

## Decision

### ADD → A1: optimistic temp-node as a client-originated append; canonical-id dedup via `resolveOptimisticEntity`; `useReadbackRefetch` narrowed to an append-loss healer

Write the optimistic node into the nested connection by driving the **same
live-edge-insert path** the SSE handler uses (`insertConnectionEdge` with the temp
id + a synthetic cursor) — an append that *originates locally* instead of from the
DO. On the mutation HTTP result, `resolveOptimisticEntity(tempId, serverId)`
rewrites the id across all list states (fate already does this for Class B). Any
server `appendNode` — before or after — then dedups by canonical id
(`removeEntityFromListState` / visible-dedup).

- **Dedup/reconcile:** one canonical id ⇒ one edge, by fate's existing machinery.
  The optimistic add is literally "a locally-authored append the server append
  later collapses into."
- **Divergence:** exactly one **sub-second transient double** window — a server
  `appendNode(server-id)` landing *before* the HTTP result resolves temp→server. In
  practice the author's HTTP result beats the DO fan-out, and per #714 the append is
  frequently lost entirely (so resolution wins by default). The window collapses the
  instant the HTTP result resolves. **Zero *persistent* divergence.**
- **`useReadbackRefetch`: kept, narrowed to the append-loss healer.** After
  resolution the optimistic node already carries the server id, so a readback
  `network-only` refetch dedups cleanly; it fires only if the append was lost. It is
  no longer the primary "make my row appear" path — it is the healer of last resort.
- **Injection is a phoenix client helper, not an upstream fate affordance** (open
  question 3, resolved). fate has no public "optimistic membership for a nested
  connection"; a phoenix helper writes the nested list state + snapshots it for
  rollback (mirroring fate's `listSnapshots`) and reuses `resolveOptimisticEntity`
  untouched. Keeping it in phoenix avoids coupling the epic to an upstream fate
  release; if the shape proves stable it can be pushed upstream later.

**Not A2.** A2 (server-echo `clientCorrelationId` stamped on the append frame, author
suppresses its own append) would make the double window *unrepresentable* rather
than merely sub-second — but at the cost of a **fate wire-protocol change**
(`worker/features/fate-live/protocol.ts` + `live-publisher.ts` + the mutation input
schema + client suppression). **Escalate to A2 only if the sub-second transient
double proves unacceptable in practice.** That is the maintainer-override seam for
the add side.

### DELETE → D1: reply-aware optimistic mirroring the server branch, decided from the loaded client tree, with a conservative-tombstone fallback

The client already builds the comment tree (`buildCommentTree` / `childrenByParent`
in `PanoPostDetail.tsx`), so leaf-vs-has-replies is a **local** decision. Mirror the
server's branch:

- **leaf** (client-certain: subtree loaded, no children) → optimistic **edge-drop**;
- **has replies OR uncertain** (unloaded subtree) → optimistic **`[silindi]`
  tombstone** (set `deletedAt`/body locally, keep the row);
- **`definition.delete`** → **always** optimistic **edge-drop** (no reply tree);
  `definition.delete` collapses to a plain edge-drop.

- **Dedup/reconcile:** leaf-drop reconciles with the server `deleteEdge`; tombstone
  reconciles with the server `live.update` tombstone (an idempotent field write, the
  same shape as the `savedReconcile` precedent where a live *field* — not edge
  presence — drives the row's state).
- **Divergence made unrepresentable:** the only hazard is a **stale tree** (client
  thinks leaf; someone else added a reply the client hasn't loaded) → client removes
  a row the server tombstones, and a `live.update` can't re-add a removed edge. The
  fallback rule removes this: optimistic edge-drop **only** when the subtree is
  client-certain-empty; otherwise tombstone (the safe superset). A tombstone is never
  *wrong* — for a true leaf it just lingers a beat until `deleteEdge` removes it.
- **Rollback** rides fate's existing rollback-before-throw: snapshot the nested
  list/row, restore on reject — consistent with the wire-error handling in
  [.patterns/fate-mutations-client.md](../.patterns/fate-mutations-client.md).

### Open questions, resolved to defaults

- **(2) Lost leaf `deleteEdge` → accept manual-refresh; no symmetric delete-readback
  in v1.** The lost-append healer exists for add because add-loss is the #714 common
  case; a lost leaf-`deleteEdge` is rarer and its worst case is a stale-present row a
  manual refresh clears. Adding a delete-side read-back is the escalation if this
  proves annoying — the maintainer-override seam for the delete side.
- **(3) A1 injection is a phoenix client helper, not an upstream fate affordance**
  (see ADD → A1).

### The no-divergence invariant (the ADR's core)

> Every list-membership change is keyed by **canonical entity id**, and the
> optimistic write is either **(a) collapsible into the authoritative frame by that
> id** (add — temp id rewritten to the server id on the HTTP result, then fate's
> canonical-id dedup makes temp-node and server-append the same edge), or **(b) a
> conservative superset of the authoritative outcome** (delete — a tombstone-on-
> uncertain that the server either confirms (`live.update`) or shrinks
> (`deleteEdge`), never contradicts).

Temp ids are rewritten to server ids on the HTTP result before any lasting
reconciliation; `useReadbackRefetch` heals a lost append; rollback-before-throw
clears the optimistic write on reject.

## Consequences

- **`.patterns/fate-mutations-client.md`'s "no optimistic temp-node" note is
  retired.** A nested-connection optimistic temp-node **is** now allowed; dedup is by
  canonical entity id via `resolveOptimisticEntity`; `useReadbackRefetch` is narrowed
  to the append-loss healer. The pattern doc is updated in this PR to point here.
- **Phase 2 children (#1678–#1681) can be executed from this ADR without
  re-deriving the reconciliation model.** The nested-add slices implement A1 (the
  phoenix client helper + `resolveOptimisticEntity` reconciliation + narrowed
  readback); the nested-delete slices implement D1 (the reply-aware branch decided
  from the loaded tree + conservative-tombstone fallback + snapshot rollback). Each
  ships dark behind its containment flag per ADR
  [0083](0083-agents-deploy-humans-release.md), consistent with the other epic-#1637
  optimistic slices.
- **New optimistic membership for any future nested connection** follows the same
  fork: add ⇒ client-append + canonical-id dedup; delete ⇒ mirror the server's
  reply-aware branch from the loaded tree, tombstone on uncertainty.
- **Two named escalation seams for the maintainer override**, both isolated to one
  side: A2 (correlation-id echo) eliminates the add-side transient double at the cost
  of a fate wire-protocol change; a delete-side read-back heals the rare lost leaf
  `deleteEdge`. Neither is v1.
- **Effect/effect-smol is not load-bearing here** — the whole decision is client-side
  fate reconciliation. The server branch it mirrors (ADR 0096's
  `deleteEdge`-vs-tombstone) is unchanged.
- Grounded in `@nkzw/fate@1.3.1` client source, `worker/features/{pano,sozluk}/
  mutations.ts` + `fate-live/*`, `apps/web/src/fate/{readback,useReadbackRefetch}.ts`,
  `pages/{PanoPostDetail,SozlukTermPage}.tsx`, `pages/savedReconcile.ts`, and
  [.patterns/fate-mutations-client.md](../.patterns/fate-mutations-client.md) /
  [.patterns/fate-live-views.md](../.patterns/fate-live-views.md).
</content>
