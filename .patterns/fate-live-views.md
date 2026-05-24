# Live views

How views stay current without refetching. The short answer: a component swaps `useView` → `useLiveView` to subscribe a ref to server-pushed updates. Updates flow over one SSE connection per client, fan out across Worker isolates through a **`LiveDO`** Durable Object, and merge into the normalized cache so only the affected fields re-render. Mutations drive the updates by publishing `live.*` events.

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

The browser uses fate's **native SSE client** (`EventSource`), pointed at `/fate/live`. There is no custom connector: the client opens the stream (`GET /fate/live?connectionId=…`) and POSTs `subscribe`/`subscribeConnection`/`unsubscribe` control messages to the same path. phoenix's job is to serve that protocol from the DO rather than from fate's in-Worker `handleLiveRequest` (which can't fan out across isolates).

## The Durable Object — `LiveDO`

One DO class, two roles, addressed by name:

- **Connection role** `connection:<connectionId>` — owns one client's open SSE stream (the `ReadableStream` controller) and that connection's subscription list.
- **Topic role** `topic:<topicKey>` — owns the durable subscriber registry for one topic (`topicKey` = hash of `liveEntityTopic(type,id)` / `liveConnectionTopic(procedure,args)` / `liveGlobalConnectionTopic(procedure)` from `@nkzw/fate/server`).

```
                         publish (any isolate)
mutation ──live.update──▶ LiveEventBus.publish(topic, event)
                              │  env.LIVE_DO.get(idFromName("topic:"+key)).fetch("/publish")
                              ▼
                         Topic DO ── lists subscriber rows from storage ──▶ for each connectionId:
                              │  env.LIVE_DO.get(idFromName("connection:"+id)).fetch("/deliver")
                              ▼
                         Connection DO ── writes SSE frame to its stream ──▶ client (cache merge, re-render)
```

**Subscribe.** Client opens `GET /fate/live?connectionId=…` → Worker authenticates (below) → routes to the connection DO `/connect`, which returns a `text/event-stream` response, holds the stream controller, writes `: connected`, and starts a heartbeat. A `subscribe`/`subscribeConnection` control POST → connection DO records the subscription and calls the relevant topic DO `/register` with `{connectionId, subId, topic}`. `unsubscribe` reverses it.

**Deliver.** A publish reaches the topic DO, which reads its subscriber rows from storage and, per connection, calls the connection DO `/deliver`. The connection DO writes the fate-protocol frame (`event: next | connection | delete`) to its held stream. The frame carries the inline `data`/`node` the mutation published — no re-resolution.

**Durability.** Subscriber rows live in DO storage (topic DO), not memory, so they survive eviction. Each connection carries a `generation` (bumped on every `/connect`) and each subscription a `revision`; stale rows are detected on deliver and pruned by a 60s `alarm()`.

**Replay.** v1 resumes **live-only** on reconnect — the client resubscribes and goes live; events missed during the gap reconcile on the next cache read or navigation. Lossless replay (a bounded per-topic event log keyed by `eventId`, replayed on `lastEventId`) is a deferred follow-on, not built in v1.

> **On hibernation.** An open SSE stream pins its connection DO in memory. At phoenix's scale that's fine. The escape hatch, if concurrent live connections grow large, is to switch the browser transport to a WebSocket and use the DO WebSocket Hibernation API — a transport swap behind the same bus + topology, not a redesign.

## The `LiveEventBus` shim

`createFateServer({live})` still takes a bus so mutation resolvers have the `live.*` publish API. phoenix's bus is **publish-only**: `update`/`delete`/`connection().*` resolve topic strings and `fetch` the topic DO; `subscribe`/`subscribeConnection` throw (never called, because the SSE protocol is served by the DO, not by fate's `handleLiveRequest`). It must still expose a `subscribe` property — fate detects a bus by `"subscribe" in live`.

```ts
// worker/fate/live.ts
export const liveBus: LiveEventBus = {
  update: (type, id, opts) => publish(liveEntityTopic(type, id), {type: "update", id, ...opts}),
  delete: (type, id, opts) => publish(liveEntityTopic(type, id), {type: "delete", id, ...opts}),
  connection: (procedure, args) => connectionHandle(procedure, args),  // .appendNode/… → publish(topic, …)
  subscribe() { throw new Error("live subscriptions are served by LiveDO"); },
  subscribeConnection() { throw new Error("live subscriptions are served by LiveDO"); },
  emit: (...) => /* … */,
};
```

`publish` resolves the env-bound `LIVE_DO` binding (via `AsyncLocalStorage` or a context-passed env, like void) and `waitUntil`s the fan-out so it doesn't block the mutation response. Wire it in `createFateServer({live: liveBus})` and route `/fate/live` to the DO ([fate-server-wiring.md](./fate-server-wiring.md)).

## Auth {#auth}

The live stream authenticates with the **better-auth session cookie**, same as the data transport ([fate-client-setup.md](./fate-client-setup.md)). fate opens the `EventSource` with `withCredentials: true`, so the session cookie rides the SSE `GET` automatically — no token in the URL, no header. Same-origin (one Worker) makes this work. The Worker validates the cookie with `Pasaport.validateSession` at `GET /fate/live`, before handing off to the connection DO, and rejects unauthenticated opens. The connection DO records the owner so a control message can't subscribe on another user's behalf.

## wrangler config

`LiveDO` is the first Durable Object in phoenix; it needs a binding and a SQLite-class migration:

```jsonc
"durable_objects": {"bindings": [{"name": "LIVE_DO", "class_name": "LiveDO"}]},
"migrations": [{"tag": "v1", "new_sqlite_classes": ["LiveDO"]}]
```

The DO runs locally under miniflare, so there is one live path in every environment.

## See also

- [fate-mutations.md](./fate-mutations.md) — where `live.*` is published, and the inline re-resolution
- [fate-mutations-client.md](./fate-mutations-client.md) — connection membership driven by these events
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `useView`/`useListView` the live hooks mirror
- [fate-server-wiring.md](./fate-server-wiring.md) — mounting the `/fate/live` route and the `live` bus
- void reference (in the [fate](https://github.com/usirin/fate) repo): `packages/void-fate/src/server.ts`, `example/void/src/fate/live.ts`, and void's `createLiveDurableObject` (the DO template)
- fate live internals: `packages/fate/src/server/live.ts` (`LiveEventBus`), `liveTopics.ts`, `protocol.ts` (live message types)
