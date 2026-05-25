# Live views

How views stay current without refetching. The short answer: a component swaps `useView` → `useLiveView` to subscribe a ref to server-pushed updates. Updates flow over one SSE connection per client, fan out across Worker isolates through two Durable Object classes — **`ConnectionDO`** (per-client stream) and **`TopicDO`** (per-topic registry) — and merge into the normalized cache so only the affected fields re-render. Mutations drive the updates by publishing `live.*` events.

Live is the one place phoenix runs Durable Objects: cross-isolate fan-out has no in-memory shortcut on Workers, so the DOs are load-bearing, not optional. The client transport is plain SSE — fate's native live client, no custom connector.

## Client — opt a ref into live

`useLiveView` / `useLiveListView` are drop-in replacements for `useView` / `useListView`. The view definitions don't change:

```tsx
const post = useLiveView(PostView, postRef);                       // entity field updates
const [comments, loadNext] = useLiveListView(CommentConnectionView, post.comments); // list membership
```

- One **shared SSE connection** per client carries every subscription; the client ref-counts subscriptions so multiple components watching the same entity share one server-side subscription.
- Updates merge into the cache and re-render only components reading a changed field — switching `useView` → `useLiveView` needs no other changes because both read the same store.
- A connection view can opt into eager insertion: `live: {append: "visible"}` on the connection selection.
- Live failures never throw into the tree; they go to `onLiveError` on the client ([fate-client-setup.md](./fate-client-setup.md)). On reconnect the client resubscribes every active operation with its `lastEventId`.

## Server — publishing from mutations

A mutation resolver publishes events after the write, through the `live` handle ([fate-mutations.md](./fate-mutations.md)):

```ts
// inside a fateMutation, after the service write + re-resolve
live.update("Post", post.id, {changed: ["score", "myVote"], data: post});
live.connection("Post.comments", {id: post.id}).appendNode("Comment", comment.id, {node: comment});
live.connection("posts").prependNode("Post", post.id);
live.connection("Post.comments", {id: postId}).deleteEdge("Comment", commentId);
```

- `live.update(type, id, {changed, data})` — entity field change. **Publish the re-resolved entity inline as `data`.** The mutation already re-resolved it for its own response ([fate-mutations.md](./fate-mutations.md)), so the live event carries resolved data and each client masks it to its own selection. The DO does no database work and needs no Effect runtime.
- `live.connection(name | "Type.field", args?).appendNode/prependNode/deleteEdge/invalidate(...)` — list membership. Pass the resolved `node` inline.
- Connection identity strips pagination args, keeps filter args — `live.connection("posts")` reaches every feed-sort variant; `live.connection("Post.comments", {id})` targets one post's comments.

This is why connection membership is server-driven ([fate-mutations-client.md](./fate-mutations-client.md)): one publish updates every subscribed client, instead of each client patching its own cache.

## Transport — SSE

The built-in `createLiveEventBus()` is an in-memory `EventEmitter`: a `live.update` in the isolate handling the mutation reaches only subscribers in **that** isolate. On Workers every request may land in a different isolate, so it cannot fan out. phoenix keeps fate's SSE wire protocol but moves the connection-owning and fan-out into a Durable Object — the same topology void uses.

The browser uses fate's **native SSE client** (`EventSource`), pointed at `/fate/live`. There is no custom connector: the client opens the stream (`GET /fate/live?connectionId=…`) and POSTs `subscribe`/`subscribeConnection`/`unsubscribe` control messages to the same path. phoenix's job is to serve that protocol from the DOs rather than from fate's in-Worker `handleLiveRequest` (which can't fan out across isolates).

## The Durable Objects — `ConnectionDO` + `TopicDO`

Two cohesive classes, each addressed by name, sharing the wire vocabulary through `live-protocol.ts` (frame shapes, topic-key derivation, the deliver/probe contract). An instance is always exactly one role — that's why this is two classes, not one (ADR 0025 split the former one-class `LiveDO`):

- **`ConnectionDO`** `connection:<connectionId>` (`connection-do.ts`) — owns one client's open SSE stream (the `ReadableStream` controller), that connection's subscription list, the validated owner, and the persisted `generation`. Handles `/connect`, `/subscribe`, `/unsubscribe`, `/deliver`, `/probe`. Its **only** persisted state is the `generation` counter; the controller and subscription list live in memory (the open stream pins the DO in memory anyway). It does no database work and has no Effect runtime — it writes the frame a `TopicDO` hands it verbatim.
- **`TopicDO`** `topic:<topicKey>` (`topic-do.ts`) — owns the durable `subscribers` SQL registry for one topic, the publish fan-out, and the alarm reap. Handles `/register`, `/deregister`, `/publish`. The `subscribers` table (and its idempotent `misses`-column guard) lives only in this constructor — no class provisions storage it never reads. `topicKey` = hash of `liveEntityTopic(type,id)` / `liveConnectionTopic(procedure,args)` / `liveGlobalConnectionTopic(procedure)` from `@nkzw/fate/server`, derived in `live-protocol.ts`.

Cross-role calls are **unrepresentable**: a `ConnectionDO` reaches topics only through the `TOPIC_DO` binding (typed to `TopicDO`), and a `TopicDO` reaches connections only through `CONNECTION_DO` (typed to `ConnectionDO`). Neither class holds a binding to its own kind, so connection→connection and topic→topic calls have no path — the misroute can't be written, let alone dispatched.

```
                         publish (any isolate)
mutation ──live.update──▶ liveBus.publish(message)
                              │  env.TOPIC_DO.get(idFromName("topic:"+key)).fetch("/publish")
                              ▼
                         TopicDO ── lists subscriber rows from SQL storage ──▶ for each connectionId:
                              │  env.CONNECTION_DO.get(idFromString(connectionId)).fetch("/deliver")
                              ▼
                         ConnectionDO ── writes SSE frame to its stream ──▶ client (cache merge, re-render)
```

**Subscribe.** Client opens `GET /fate/live?connectionId=…` → Worker authenticates (below) → routes to the `ConnectionDO` `/connect`, which returns a `text/event-stream` response, holds the stream controller, writes `: connected`, and starts a heartbeat. A `subscribe`/`subscribeConnection` control POST → the `ConnectionDO` records the subscription and calls the relevant `TopicDO` `/register` with `{connectionId, subId, generation}`. `unsubscribe` reverses it (`/deregister`).

**Deliver.** A publish reaches the `TopicDO`, which reads its subscriber rows from storage and, per connection, calls the `ConnectionDO` `/deliver`. The `ConnectionDO` writes the fate-protocol frame (`event: next | connection | delete`) to its held stream. The frame carries the inline `data`/`node` the mutation published — no re-resolution.

**Durability + stale detection.** Subscriber rows live in `TopicDO` SQL storage, not memory, so they survive eviction. Each `ConnectionDO` carries a `generation`, persisted and bumped on every `/connect`; each subscriber row records the generation it registered under. On `/deliver` the connection reports its current generation, and a row is pruned **only** when a *reachable* connection reports a different one (its stream lifetime is over) — never on a single transport/deserialize failure. A 60s `alarm()` on the `TopicDO` probes the same way (`/probe` reads the generation without touching the stream) and reaps a row whose connection stays unreachable across the cycle (a persisted consecutive-miss count, evicted after `MAX_PROBE_MISSES = 3`, reset on any reachable probe). Every cross-DO `/deliver` / `/probe` fetch is bounded by a 2s timeout (`FANOUT_TIMEOUT_MS`) so one unreachable connection can't stall the single-threaded `TopicDO`.

**Replay.** Resumes **live-only** on reconnect — the client resubscribes and goes live; events missed during the gap reconcile on the next cache read or navigation. Lossless replay (a bounded per-topic event log keyed by `eventId`, replayed on `lastEventId`) is a deferred follow-on, not built.

> **On hibernation.** An open SSE stream pins its `ConnectionDO` in memory. At phoenix's scale that's fine. The escape hatch, if concurrent live connections grow large, is to switch the browser transport to a WebSocket and use the DO WebSocket Hibernation API — a transport swap behind the same bus + topology, not a redesign.

## The `LiveEventBus` shim

`createFateServer({live})` still takes a bus so mutation resolvers have the `live.*` publish API. phoenix's bus is **publish-only**: `update`/`delete`/`connection().*` resolve topic strings and `fetch` the `TopicDO`; `subscribe`/`subscribeConnection` throw (never called, because the SSE protocol is served by `ConnectionDO`, not by fate's `handleLiveRequest`). It must still expose a `subscribe` property — fate detects a bus by `"subscribe" in live`.

```ts
// worker/fate/live.ts
export const liveBus: PhoenixLiveEventBus = {
  update: (type, id, opts) => publish({kind: "entity", match: {type, entityId: String(id)}, frame: /* … */}),
  delete: (type, id, opts) => publish({kind: "entity", match: {type, entityId: String(id)}, frame: {delete: true, id}}),
  connection: (procedure, args) => connectionHandle(procedure, args),  // .appendNode/… → publish(connection msg)
  subscribe() { throw new Error("live subscriptions are served by ConnectionDO, not the bus"); },
  subscribeConnection() { throw new Error("live subscriptions are served by ConnectionDO, not the bus"); },
  emit: (...) => /* … */,
};
```

`publish` resolves the env-bound `TOPIC_DO` binding (via `AsyncLocalStorage`, the per-request `livePublishContext`) and `waitUntil`s the fan-out to every topic the message targets so it doesn't block the mutation response. Wire it in `createFateServer({live: liveBus})` and route `/fate/live` to the `ConnectionDO` ([fate-server-wiring.md](./fate-server-wiring.md)).

## Auth {#auth}

The live stream authenticates with the **better-auth session cookie**, same as the data transport ([fate-client-setup.md](./fate-client-setup.md)). fate opens the `EventSource` with `withCredentials: true`, so the session cookie rides the SSE `GET` automatically — no token in the URL, no header. Same-origin (one Worker) makes this work. The Worker validates the cookie with `Pasaport.validateSession` at `GET /fate/live`, before handing off to the `ConnectionDO`, and rejects unauthenticated opens. The `ConnectionDO` records the owner so a control message can't subscribe on another user's behalf.

## wrangler config

The live DOs are the only Durable Objects in phoenix; they need two bindings and a SQLite-class migration. `v1` introduced the one-class `LiveDO`; the `v2` migration retires it and adds the two split classes:

```jsonc
"durable_objects": {"bindings": [
  {"name": "CONNECTION_DO", "class_name": "ConnectionDO"},
  {"name": "TOPIC_DO", "class_name": "TopicDO"}
]},
"migrations": [
  {"tag": "v1", "new_sqlite_classes": ["LiveDO"]},
  {"tag": "v2", "new_sqlite_classes": ["ConnectionDO", "TopicDO"], "deleted_classes": ["LiveDO"]}
]
```

Both DOs run locally under miniflare, so there is one live path in every environment.

## See also

- [ADR 0023](../.decisions/0023-live-views-sse-livedo.md) — the SSE transport, DO fan-out, cookie auth, and `generation` decisions (amended-in-part by 0025; those semantics stand unchanged)
- [ADR 0025](../.decisions/0025-split-livedo-connection-topic.md) — why the one-class `LiveDO` was split into `ConnectionDO` + `TopicDO`
- [fate-mutations.md](./fate-mutations.md) — where `live.*` is published, and the inline re-resolution
- [fate-mutations-client.md](./fate-mutations-client.md) — connection membership driven by these events
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `useView`/`useListView` the live hooks mirror
- [fate-server-wiring.md](./fate-server-wiring.md) — mounting the `/fate/live` route and the `live` bus
- void reference (in the [fate](https://github.com/usirin/fate) repo): `packages/void-fate/src/server.ts`, `example/void/src/fate/live.ts`, and void's `createLiveDurableObject` (the DO template)
- fate live internals: `packages/fate/src/server/live.ts` (`LiveEventBus`), `liveTopics.ts`, `protocol.ts` (live message types)
