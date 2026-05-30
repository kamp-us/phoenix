# Live views

How views stay current without refetching. The short answer: a component swaps `useView` → `useLiveView` to subscribe a ref to server-pushed updates. Updates flow over one SSE connection per client, fan out across Worker isolates through a single Durable Object class — **`LiveDO`**, which plays both the per-client connection role and the per-topic registry role, keyed by instance name — and merge into the normalized cache so only the affected fields re-render. Mutations drive the updates by publishing `live.*` events.

Live is the one place phoenix runs a Durable Object: cross-isolate fan-out has no in-memory shortcut on Workers, so the DO is load-bearing, not optional. The client transport is plain SSE — fate's native live client, no custom connector.

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

## The Durable Object — one unified `LiveDO`

A single class playing both roles, addressed by name, sharing the wire vocabulary through `protocol.ts` (frame shapes, topic-key derivation, the `SubscriberRow` + deliver/check contract). An instance is always exactly one role, picked by `resolveRole(state.id.name)` — a void-aligned rewrite of the former split pair ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md) supersedes [0025](../.decisions/0025-split-livedo-connection-topic.md)):

- **Connection role** `connection:<connectionId>` — owns one client's held SSE stream (a `Queue` of frames merged with a 15s keep-alive tick), that connection's subscription map (each sub's `revision` + active flag + topics), and the persisted `generation` scalar. Exposes `subscribe` / `unsubscribe` / `deliver` / `check` RPC plus the `fetch` that opens the stream. Its **only** persisted state is the `generation` counter (KV key `connection:generation`); the queue and subscription map live in memory (the open stream pins the DO in memory anyway). It does no database work — it enqueues the frame a topic instance hands it verbatim.
- **Topic role** `topic:<topicKey>` — owns the durable subscriber registry for one topic (KV rows under `sub:${topicKey}:…`), the publish fan-out, and the alarm reap. Exposes `register` / `unregister` / `publish` RPC plus the `alarm`. Storage is the KV API, not SQLite — no SQL table, no `@effect/sql-sqlite-do`. `topicKey` = hash of `liveEntityTopic(type,id)` / `liveConnectionTopic(procedure,args)` / `liveGlobalConnectionTopic(procedure)` from `@nkzw/fate/server`, derived in `protocol.ts`.

Cross-role calls ride the DO's **OWN** namespace — resolved once in shared init via `LiveDO.from("phoenix")` and held in the closure. A connection instance reaches topics with `live.getByName(\`topic:${key}\`)`, a topic reaches connections with `live.getByName(\`connection:${id}\`)`. Because it is one class referencing its own namespace by host script name, there is no sibling Layer cycle (every RPC method's `R` is `never`) — this is what retired [ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md). A misrouted call (e.g. `register` on a `connection:` instance) is role-guarded and no-ops; the misroute is no longer unrepresentable at the type level (the one guarantee 0037 trades away).

```
                         publish (any isolate)
mutation ──live.update──▶ LiveTopics.publish(topicKey, message, limits)
                              │  live.getByName(`topic:${key}`).publish({topicKey, frame, limits})   (typed RPC)
                              ▼
                         LiveDO (topic role) ── lists subscriber rows from KV ──▶ for each connectionId:
                              │  live.getByName(`connection:${id}`).deliver({frame: {...frame, id: row.subId}, row, limits})
                              ▼
                         LiveDO (connection role) ── offers SSE frame onto its held queue ──▶ client (cache merge, re-render)
```

**Subscribe.** Client opens `GET /fate/live?connectionId=…` → Worker authenticates (below) → forwards the request to a `connection:` instance's `fetch`, which returns a `text/event-stream` response, opens the held queue, writes `: connected`, and starts the 15s keep-alive. A `subscribe`/`subscribeConnection` control POST → the connection instance records the subscription (bumping its `revision`) and calls each `topic:` instance's `register` with the `SubscriberRow` (`{topicKey, connectionId, subId, generation, revision}`). `unsubscribe` reverses it (`unregister`).

**Deliver.** A publish reaches a `topic:` instance, which lists its subscriber rows from KV and, per connection, calls the `connection:` instance's `deliver` — stamping each frame's `id` from the subscriber row (one publish, many per-subscriber ids). The connection instance offers the fate-protocol frame (`event: next | connection | delete`) onto its held queue. The frame carries the inline `data`/`node` the mutation published — no re-resolution.

**Durability + stale detection.** Subscriber rows live in topic-role KV storage, not memory, so they survive eviction. Each connection persists a `generation`, bumped on every (re)connect; each subscriber row records the generation + revision it registered under. On `deliver`/`check` the connection answers from its in-memory subscription map + the persisted generation: a row is stale when its `generation` ≠ the connection's current generation, or its subscription is inactive, or its `revision` differs. A reachable connection reports exactly which rows are stale; those are reaped. A 60s `alarm()` on the topic role probes the same way (`check` reads staleness without touching the stream) and reaps on the **first** failed/timed-out probe — it deletes ALL that connection's rows for the topic, with **no** consecutive-miss counter (void-faithful). Every cross-role `deliver`/`check` is bounded by a per-call timeout (`deliveryAttemptTimeoutMs`, default 1.5s) so one unreachable connection can't stall the single-threaded DO.

**Replay.** Resumes **live-only** on reconnect — the client resubscribes and goes live; events missed during the gap reconcile on the next cache read or navigation. Lossless replay (a bounded per-topic event log keyed by `eventId`, replayed on `lastEventId`) is a deferred follow-on, not built.

> **On hibernation.** An open SSE stream pins its connection-role `LiveDO` instance in memory. At phoenix's scale that's fine. The escape hatch, if concurrent live connections grow large, is to switch the browser transport to a WebSocket and use the DO WebSocket Hibernation API — a transport swap behind the same bus + topology, not a redesign.

## The `LiveEventBus` shim

`createFateServer({live})` still takes a bus so mutation resolvers have the `live.*` publish API. phoenix's bus is **publish-only**: `update`/`delete`/`connection().*` resolve topic strings and fire the topic-role `publish` RPC; `subscribe`/`subscribeConnection` throw (never called, because the SSE protocol is served by the `/fate/live` route + `LiveDO`, not by fate's `handleLiveRequest`). It must still expose a `subscribe` property — fate detects a bus by `"subscribe" in live`.

```ts
// worker/features/fate-live/event-bus.ts
export const liveBus: PhoenixLiveEventBus = {
  update: (type, id, opts) => publish({kind: "entity", match: {type, entityId: String(id)}, frame: /* … */}),
  delete: (type, id, opts) => publish({kind: "entity", match: {type, entityId: String(id)}, frame: {delete: true, id}}),
  connection: (procedure, args) => connectionHandle(procedure, args),  // .appendNode/… → publish(connection msg)
  subscribe() { throw new Error("live subscriptions are served by the LiveDO, not the bus"); },
  subscribeConnection() { throw new Error("live subscriptions are served by the LiveDO, not the bus"); },
  emit: (...) => /* … */,
};
```

`publish` fans the message out to every topic key it targets through the per-request `livePublishContext` (an `AsyncLocalStorage` carrying a typed-RPC `LivePublisher` closure, **not** `{env, waitUntil}`). The `/fate` route builds that publisher from the worker-init-resolved `LiveDO` namespace — `LiveTopics.publish(topicKey, message, limits)` fires `live.getByName(\`topic:${key}\`).publish({topicKey, frame, limits})`, fired-and-forgotten via `Cloudflare.WorkerExecutionContext.waitUntil` so it doesn't block the mutation response. No `env`-based lookup, no `idFromName`, no string-URL `stub.fetch` (ADR 0028/0029). Wire it in `createFateServer({live: liveBus})` and route `/fate/live` to a connection-role `LiveDO` instance ([fate-server-wiring.md](./fate-server-wiring.md)).

## Auth {#auth}

The live stream authenticates with the **better-auth session cookie**, same as the data transport ([fate-client-setup.md](./fate-client-setup.md)). fate opens the `EventSource` with `withCredentials: true`, so the session cookie rides the SSE `GET` automatically — no token in the URL, no header. Same-origin (one Worker) makes this work. The Worker validates the cookie with `Pasaport.validateSession` at `GET /fate/live`, before forwarding to the connection-role `LiveDO` instance, and rejects unauthenticated opens. The connection instance records the owner so a control message can't subscribe on another user's behalf.

## DO binding — alchemy-managed

`LiveDO` is the only Durable Object in phoenix. There is no `wrangler.jsonc` and no hand-written `durable_objects` / `migrations` block (ADR 0026–0028): the worker declares the single class as its `Deps` contract — `Cloudflare.Worker<Phoenix, {}, LiveDO>()("phoenix", …)` — and provides `LiveDOLive` ([alchemy-durable-objects.md](./alchemy-durable-objects.md)). alchemy derives the DO migration from the binding (a new DO class defaults to `new_sqlite_classes` under the hood, tracked via worker tags — see [alchemy-stack-deploy.md](./alchemy-stack-deploy.md)), so declaring + providing the class is all it takes. KV storage means there is no SQL migration directory for the registry either.

The DO runs locally under the same `alchemy dev` worker, so there is one live path in every environment.

## See also

- [ADR 0023](../.decisions/0023-live-views-sse-livedo.md) — the SSE transport, DO fan-out, cookie auth, and `generation` decisions (amended-in-part by 0037; the SSE/fan-out/auth semantics stand unchanged)
- [ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md) — why the split `ConnectionDO`/`TopicDO` pair was reunified into one void-aligned `LiveDO` (supersedes 0025, retires 0033)
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the unified `LiveDO` recipe (`.make()`, role dispatch, KV, the alarm)
- [fate-mutations.md](./fate-mutations.md) — where `live.*` is published, and the inline re-resolution
- [fate-mutations-client.md](./fate-mutations-client.md) — connection membership driven by these events
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `useView`/`useListView` the live hooks mirror
- [fate-server-wiring.md](./fate-server-wiring.md) — mounting the `/fate/live` route and the `live` bus
- void reference (in the [fate](https://github.com/usirin/fate) repo): `packages/void-fate/src/server.ts`, `example/void/src/fate/live.ts`, and void's `createLiveDurableObject` (the DO template)
- fate live internals: `packages/fate/src/server/live.ts` (`LiveEventBus`), `liveTopics.ts`, `protocol.ts` (live message types)
