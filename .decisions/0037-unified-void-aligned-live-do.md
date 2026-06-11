---
id: 0037
title: Unified void-aligned LiveDO — one class, two roles, KV storage
status: accepted
date: 2026-05-30
tags: [live, durable-objects, sse, alchemy, effect]
---

# 0037 — Unified void-aligned LiveDO — one class, two roles, KV storage

## Context

phoenix's live fan-out was two co-hosted Durable Objects with a bidirectional
RPC edge: `ConnectionDO` (one client's held SSE stream + subscription list) and
`TopicDO` (the durable subscriber registry + the publish fan-out + the reap
alarm). [0025](0025-split-livedo-connection-topic.md) split them out of the
original one-class `LiveDO` ([0023](0023-live-views-sse-livedo.md)) to make
invalid cross-role calls unrepresentable; [0028](0028-effect-durable-object-model.md)
ported both onto alchemy's Effect DO model;
[0033](0033-mutual-do-layer-cycle-per-call-resolution.md) established that the
two classes referencing each other could not Init-bind the sibling without a
circular Layer dependency, so the sibling was resolved per RPC call.

Two costs accumulated from the split:

- **The mutual-DO Layer cycle.** `ConnectionDOLive` ↔ `TopicDOLive` could not
  resolve each other in init without producing `Layer<A, _, B>` + `Layer<B, _, A>`,
  which doesn't compose. The whole of [0033](0033-mutual-do-layer-cycle-per-call-resolution.md)
  exists to work around this with per-call sibling resolution — extra ceremony
  in every cross-role RPC method, plus a sibling-pair pattern doc to teach it.
- **SQLite the registry never needed.** `TopicDO` kept its subscriber registry
  in `state.storage.sql` (a `subscribers` table + a `v2` migration +
  `@effect/sql-sqlite-do`). The registry is a flat keyed set of rows looked up
  by `(topicKey, connectionId, subId)` — a KV access pattern, not a relational
  one. The SQLite layer bought nothing the KV storage API doesn't.

[void](https://github.com/usirin/fate)'s `VoidLiveStreamDurableObject`
(`void/dist/runtime/live-server.mjs`) — the upstream phoenix's live channel
mirrors — solves the same fan-out with **one** DO class that plays both roles,
KV storage, and a stale model built on a per-connection `generation` and a
per-subscription `revision`. Aligning to void erases both costs at once.

## Decision

Replace the split `ConnectionDO`/`TopicDO` pair with a single **`LiveDO`** class
that plays both roles, distinguished by instance-name prefix. It is a
void-aligned rewrite, not a mechanical re-merge of the pre-0025 one-class form.

- **One class, two roles by instance name.** A `LiveDO` instance is named either
  `connection:<connectionId>` (connection role — owns one client's held SSE
  stream + its subscription list) or `topic:<topicKey>` (topic role — owns that
  topic's subscriber registry + the publish fan-out + the reap alarm).
  `resolveRole(state.id.name)` reads the prefix to pick the role at request time.
  A misrouted call (e.g. `register` on a `connection:` instance) hits an
  instance whose role doesn't match and harmlessly returns a no-op result —
  void has no role guard either.
- **`DurableObjectNamespaceScope` self-namespace.** The DO's OWN namespace is
  resolved **once in shared init** from `Cloudflare.DurableObjectNamespaceScope`
  (the LOCAL, scriptName-less self-binding that `.make()` provides) and held in
  the closure for cross-role addressing
  (`live.getByName(\`topic:${key}\`)` / `live.getByName(\`connection:${id}\`)`).
  This is void's `this.env[bindingName]` self-reference. Because the scope is
  provided by `.make()`, it adds no requirement, so the Layer is
  `Layer<LiveDO, never, Worker>` with every RPC method's `R` channel `never`.
  A bare `yield* LiveDO` in init would instead leak `LiveDO` as an
  unsatisfiable self-requirement — the very Tag the Layer outputs, which no
  merge can discharge.
  - **Why NOT `LiveDO.from("phoenix")`** (the shape this ADR first prescribed):
    every `.from(...)` overload sets a `scriptName` — the string directly, or
    the worker passed to `.from(Worker)` — which declares a CROSS-SCRIPT
    binding. Under `alchemy dev` that routes through the dev-registry proxy and
    dies with `Worker "phoenix" not found`; a DO reaching its own siblings must
    use the local binding, not a cross-worker reference. So there is no
    host-script-name string to keep in sync with `worker/index.ts` — the local
    scope carries no name. The scope is typed `DurableObjectNamespace<unknown>`
    (alchemy can't know each host's DO shape), widened once to this DO's
    statically-known `LiveRpcSurface` — the one `as` in `live-do.ts`.
- **KV storage, not SQLite.** Storage is `state.storage`'s KV API, mirroring
  void's flat keys: subscriber rows under
  `sub:${topicKey}:${connectionId}:${subId}:${generation}:${revision}`, and the
  per-connection generation scalar under `connection:generation`. Topic-role
  reads use `state.storage.list({prefix: "sub:${topicKey}:"})`; deletes batch
  `state.storage.delete(keys)`. No SQL table, no migration, no
  `@effect/sql-sqlite-do`.
- **`generation` + `revision` stale model.** Each connection persists a
  `generation` scalar, bumped on every (re)connect. Each subscription carries a
  `revision`, bumped on every re-subscribe under the same id. A topic-held
  subscriber row is stale when its `generation` doesn't match the connection's
  current generation, or its subscription is inactive, or its `revision` differs
  — the connection answers `deliver`/`check` from its in-memory subscription map
  + the persisted generation, with no read back to the topic.
- **First-failed-probe reap, no miss counter.** The topic role schedules a 60s
  alarm that probes each subscriber's connection via `check`. The **first**
  failed/timed-out probe (or a `publish` that can't reach a connection) reaps
  **all** of that connection's rows for the topic — void-faithful, no
  consecutive-miss counter. A reachable connection reports which of its probed
  rows are stale and exactly those are reaped.
- **15s SSE keep-alive.** The connection role holds a `Queue` of frames merged
  with a 15s keep-alive tick (`Stream.tick("15 seconds")` with the immediate tick
  dropped), returned as a streaming `HttpServerResponse` — the one interaction
  kept as `fetch`, not RPC.
- **Per-subscriber `frame.id` stamped at delivery.** One `publish` fans out to
  many subscriptions; the publish frame's `id` is left empty and the topic
  instance stamps each delivered frame's `id` from the subscriber row
  (`{...frame, id: row.subId}`) at delivery, so every subscriber sees its own id.

The split decided in [0025](0025-split-livedo-connection-topic.md) is reversed;
the SSE transport, DO-fan-out, and cookie-auth decisions of
[0023](0023-live-views-sse-livedo.md) all stand. fate's native SSE wire protocol
([0034](0034-fate-native-sse-protocol.md)) is unchanged — this is a server-side
fan-out rewrite the client never sees.

## Consequences

- **No sibling Layer cycle.** The self-namespace is the local
  `DurableObjectNamespaceScope` `.make()` provides, so every RPC method's `R`
  channel is `never` and the implementation Layer requires only `Worker`. The
  whole per-call sibling-resolution dance
  ([0033](0033-mutual-do-layer-cycle-per-call-resolution.md)) is eliminated, not
  worked around — there is no second DO Tag to resolve. At the worker call seam
  there is nothing to discharge either: the old split-DO `as never` /
  `Effect.provide(workerContext)` cast is gone. (A cross-script
  `LiveDO.from("phoenix")` would have a `Worker` requirement too, but it doesn't
  work under `alchemy dev` — see the Decision.)
- **No `@effect/sql-sqlite-do`, no migration dir.** KV storage drops the
  `subscribers` SQL table, the `v2` DO migration, and the `@effect/sql-sqlite-do`
  dependency. alchemy derives the single `LiveDO` class's DO migration from the
  binding; there is no hand-written `wrangler.jsonc` migrations block.
- **One binding, one class.** `LiveDO` replaces the `CONNECTION_DO`/`TOPIC_DO`
  pair. The worker declares the single class as its `Deps` contract
  (`Cloudflare.Worker<Phoenix, {}, LiveDO>`) and provides `LiveDOLive`.
- **Invalid cross-role calls are no longer unrepresentable at the type level.**
  This is the one thing [0025](0025-split-livedo-connection-topic.md) bought that
  this gives back: a misrouted call now type-checks and no-ops at runtime
  (role-guarded by `resolveRole`) rather than failing to compile. Accepted as
  void-faithful: the role guard is one branch, and the alignment to void's
  proven shape (which the live-fan-out survey
  [live-fan-out-options-considered.md](./0034a-live-fan-out-options-considered.md)
  already settled on) outweighs the lost compile-time guarantee.
- **Supersedes [0025](0025-split-livedo-connection-topic.md)** (the split is
  reversed). **Amends [0023](0023-live-views-sse-livedo.md)** (one-class
  packaging is restored, with KV + revision added; the rest of 0023 stands).
  **Retires [0033](0033-mutual-do-layer-cycle-per-call-resolution.md)** (the
  mutual-DO problem it solves no longer exists; the file is kept as reference).
- See [alchemy-durable-objects.md](../.patterns/alchemy-durable-objects.md) (the
  unified DO recipe), [fate-live-views.md](../.patterns/fate-live-views.md) (the
  protocol + the DO in the wider live picture), and
  [effect-sse-externally-driven.md](../.patterns/effect-sse-externally-driven.md)
  (the held-stream queue + keep-alive shape).
