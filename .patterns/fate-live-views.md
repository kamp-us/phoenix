# Live views

> Derived from `@nkzw/fate@1.3.1` — re-verify on pin bump.

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
- A connection view can opt into eager insertion: `live: {prepend: "visible"}` on the connection selection (the lib's `ConnectionLivePolicy` — `prepend?: 'edge' | 'visible'`, default `'edge'` buffers a pushed node until a page load; `PanoFeed`'s feed connection uses `"visible"`).
- Live failures never throw into the tree; they go to `onLiveError` on the client ([fate-client-setup.md](./fate-client-setup.md)). On reconnect the client resubscribes every active operation with its `lastEventId`.

### One app-lifetime global live pin keeps the stream alive {#global-pin}

A page whose only live subscription is a `useLiveListView` would otherwise lose a just-published `appendNode`/`prependNode` after a write mutation. The native client refcounts the one shared `EventSource`: `remove()` runs `if (operations.size === 0) { source.close(); nativeLiveClient = undefined }`, and the next subscribe rebuilds a fresh stream with a new random `connectionId`. `useLiveListView`'s subscribe effect re-keys on the connection's `metadata.key`, which goes transiently null during the in-flight refetch a mutation triggers (`useRequest` hands the connection back as a bare array, no `ConnectionTag`). In that window the lone subscription unsubscribes → refcount hits 0 → the stream closes → the mutation's fire-and-forget publish ([below](#the-publish-only-event-bus)) targets the now-dead `connectionId` and is dropped (v1 live is best-effort, no replay). The live event is **lost, not late**, so the new row never appears until a manual refresh.

The fix holds **one always-on live subscription for the whole authenticated session**, so `operations.size` is structurally never 0 while the app is mounted — fate's `source.close()` branch can't fire during mutation churn, the `EventSource` + `connectionId` stay stable, and every publish lands on a live connection ([ADR 0094](../.decisions/0094-app-lifetime-global-live-pin.md)). `apps/web/src/fate/useGlobalLivePin.ts` exposes `useGlobalLivePin(userId)`; `FateProvider` mounts it (gated on a non-null session user id) once, above the router, inside the `FateClient` context.

The anchor is the viewer's **own `User` row**, keyed on the better-auth session id: always valid for an authenticated session (`User.id === CurrentUser.id`, the same id the `me` query resolves) and the lightest possible — a single entity-field subscription, no list/connection fan-out, no pagination churn. It never fires for an anonymous client (the caller gates on `userId != null`; an anon `EventSource` 401-loops). It releases on sign-out/unmount, so the stream tears down cleanly when the app leaves (leaking the connection is the opposite failure). This makes the transient-0-refcount state unrepresentable for every authenticated live view at once, so no per-view pin is needed; the transport-level invariant is unit-proved in `apps/web/src/fate/globalLivePin.test.ts` (with the pin removed the EventSource is torn down — the falsification baseline).

### The mutator's own view never waits on a push {#read-back}

The global pin above keeps the stream alive across churn, but a second, load-driven loss remains: the create-mutation's fire-and-forget publish ([below](#the-publish-only-event-bus)) fans out to the topic `LiveDO`, which lists its subscriber rows **once** — if the subscriber's `register` RPC hasn't persisted yet, the fan-out set is empty and the `appendNode` delivers to nobody (no v1 replay). Under load the subscribe `register` slows from ~200ms to seconds, so the publish loses the race on nearly every late write and the mutator's own view waits on a push that never arrives — the new node never appears until a manual refresh (#714 diagnosis on epic #713; #711 is the durable transport-side fix).

So a view must **not** depend on the live round-trip to reflect its *own* create. After the mutator's own create succeeds, a bounded read-back self-heals the loss:

```tsx
const [items, loadNext] = useLiveListView(CommentConnectionView, post.comments);

const confirm = useReadbackRefetch({
	presentIds: items.map(({node}) => String(node.id)),
	refetch: () => fate.request({post: {view: PostDetailView, args}}, {mode: "network-only"}),
});
// in the composer's onSuccess, with the mutation result's id:
if (result?.id) confirm(String(result.id));
```

`useReadbackRefetch` (`apps/web/src/fate/useReadbackRefetch.ts`) watches the connection for the created id. Live push lands it first → it does nothing; still absent after a short grace window (a few 1s probes) → it fires **one** `fate.request(..., {mode: "network-only"})`, re-running the *same* request the page already holds so the node merges into the same live-subscribed connection. The wait-vs-refetch decision is the pure, unit-tested `decideReadback` core (`apps/web/src/fate/readback.ts`); the hook is only the timer + the single request. The live subscription and the published `appendNode` are untouched — **other** clients still update over the push; this frees only the *mutator's own* view from the race.

The same holds for the mutator's own **delete** (#1687, the collection-delete analog of the scalar self-heal #731): a lost `deleteEdge` (or soft-delete tombstone `live.update`) leaves the deleted node stuck on screen while sibling frames from the same mutation apply. `useConfirmGone` — the delete-direction twin in the same module — takes the same options and returns `confirmGone(deletedId)`: call it in the delete's success callback; if the id is still in `presentIds` after the grace window, it fires the same one-shot network-only refetch. Its pure core is `decideConfirmGone`. What to pass as `presentIds` is direction-specific: pass the ids a *lost* delete would leave stuck — for a list with soft-delete tombstones (pano comments), the **visible (non-tombstoned)** ids, so a hard delete settles when membership drops the id and a soft delete settles when the tombstone's `deletedAt` lands; for a hard-delete-only list (sözlük definitions), plain membership ids. This heals every server-side loss mode at once without resolving *which* seam lost the frame.

The fresh-slug sözlük branch (no list yet) was **not** in fact deterministic on its own: `definition.add` auto-creates the term, then `SozlukTermPage` remounts the content (a `reloadKey` bump) to flip from the empty-term branch to the list branch via a fresh `network-only term(slug)` re-read. That re-read **must be issued imperatively before the remount** — a bare `key` bump reuses the first mount's fulfilled `data:null` handle without refetching ([fate-views-and-requests.md](./fate-views-and-requests.md#remount-no-refetch), #817) — but even with the imperative re-read it is a *second* request that can race the write, and on the fresh-slug path nothing armed the read-back, so a raced re-read silently dropped the just-created definition (#730, the dominant flows-lane Family-B cause in epic #713). The fix carries the mutation's **own returned id** across the remount (`SozlukTermPage`'s `createdDefinitionId`) and arms the same `useReadbackRefetch` on it once the list branch mounts. The remount re-read is now just a fast-path that usually already carries the node (the read-back settles instantly); when it raced, the read-back deterministically refetches the node in. The mutation result is the source of truth for the just-created entity — the blind-re-read-only path is gone.

## The invalidation invariant — a mutation over a live view MUST publish {#invalidation-invariant}

**A state-mutation that writes an entity or list backing a `/fate/live` view MUST publish
its invalidation on the same request.** The client stays current only because the mutation
tells the live bus what changed; a mutation that writes the row and returns a receipt but
publishes nothing leaves every *other* open subscriber — and, absent the read-back
self-heal above, the mutator's own view — stale until a manual reload. The publish is the
authoring-side half of "live": the view opts a ref into the stream, the mutation feeds it.

State this as an invariant because the failure is silent: the write succeeds, the mutation
returns, tests over the return value pass, and the staleness only shows on a *second* open
client that never sees the change. That is exactly [#1886](https://github.com/kamp-us/phoenix/issues/1886)
(the anti-pattern below) — a promote-to-yazar write that returned success but published
nothing, so the divan UI required a manual refresh.

The invariant is **fail-safe on the publish, not on the omission**: `WorkerLivePublisher`'s
publish methods carry `E = never` (see [fate-effect-server.md](./fate-effect-server.md)), so
a publish that *is* wired can never fail the mutation — but a publish that is *never wired*
is undetectable at the type level. That gap is closed by the **landed enforcement seam**
(#1898 → ADR [0155](../.decisions/0155-fanned-mutation-publish-guard.md)): every `entity.verb`
mutation is classified fanned/not in
[`fanned-mutations.ts`](../apps/web/worker/features/fate-live/fanned-mutations.ts), and
`pipeline-cli fanout-guard check` (the `fanout-guard.yml` CI job) fails closed on an
unclassified mutation or a `fanned: true` mutation whose feature omits the publish. Authoring
a new mutation forces the fanned/not decision; this section is the *why* behind the guard.

### The reference pattern — how pano + sözlük publish {#reference-pattern}

The landed features (`features/pano/mutations.ts`, `features/sozluk/mutations.ts`) all
follow one shape. Copy it:

1. **Acquire the publisher and bind the feature's `live.ts` targets.** Each feature owns a
   single `live.ts` — the ONE place that answers "what does mutating this entity publish
   to?" It binds the entity's wire `__typename` **off the view's `typeName`**, never an
   inline `"Post"`/`"Definition"` literal ([#1127](https://github.com/kamp-us/phoenix/issues/1127)):

   ```ts
   // features/sozluk/live.ts — const DEFINITION = DefinitionView.typeName;
   const live = sozlukLive(yield* WorkerLivePublisher);
   ```

   The view is the source of the typename, so a resolver names the fan-out target instead
   of restating the magic-string seam — and the published frame is byte-identical to the
   inline wiring it replaced.

2. **Publish after the write.** Pick the shape by what changed:
   - **Scalar field reconcile** — `live.<entity>.update(id, {changed, data})`. Pass the
     re-resolved entity inline as `data` (the mutation already re-resolved it for its own
     response); each client masks it to its own selection. `changed` is a per-mutation hint
     (which fields the write touched) and does not reach the wire.

     ```ts
     yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
     ```
   - **Connection membership** — a topic `appendNode` / `prependNode` / `deleteEdge` on the
     args-scoped connection the view subscribes to (`Term.definitions` keyed by term slug,
     `Post.comments` keyed by post id, the global `posts` feed):

     ```ts
     yield* live.definition
       .term(input.termSlug)
       .appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt));
     ```

3. **`broadcastIf`-gate any node broadcast to a viewer-blind topic.** `appendNode` /
   `prependNode` push a node onto a public topic that has no per-subscriber view of the
   viewer, so a resolver cannot broadcast without discharging the sandbox `PublishDecision`
   ([#1280](https://github.com/kamp-us/phoenix/issues/1280); the `broadcastIf` gate in each
   feature's `live.ts`). `deleteEdge` / `update` carry no broadcast node, so they stay
   ungated.

The delete direction is symmetric: publish `live.<entity>.delete(id)` for the entity plus a
topic `deleteEdge(id)` on the connection it leaves, and its inverse (`restore`) re-publishes
the `appendNode` through the same sandbox gate — see `definition.delete` / `definition.restore`
in `features/sozluk/mutations.ts`.

### The anti-pattern — write, return a receipt, publish nothing {#anti-pattern}

```ts
// ANTI-PATTERN — the write lands, the mutation returns, NOTHING is published.
Effect.fn("promote")(function* ({input}) {
  const user = yield* CurrentUser.required;
  yield* service.promote(input.id);
  return {ok: true};   // ← stale-til-reload: every OTHER open subscriber never sees it
});
```

A mutation that fans out an entity/list change but returns only a receipt (or returns the
re-resolved entity but never publishes) is **stale-til-reload** — the exemplar is
[#1886](https://github.com/kamp-us/phoenix/issues/1886): the promote-to-yazar write
succeeded but the divan UI required a manual refresh because no `live.*` invalidation
followed the write. The fix is always the reference pattern above: after the write, publish
the reconcile through the feature's `live.ts`.

## Server — publishing from mutations

A mutation handler publishes events after the write, through the per-request `LivePublisher` service ([fate-effect-operations.md](./fate-effect-operations.md) "Write conventions"):

```ts
// inside a Fate.mutation handler, after the service write + shaping
const live = yield* LivePublisher;
yield* live.update("Post", post.id, {changed: ["score", "myVote"], data: post});
yield* live.topic("Post.comments", {id: post.id}).appendNode("Comment", comment.id, {node: comment});
yield* live.topic("posts").prependNode("Post", post.id);
yield* live.topic("Post.comments", {id: postId}).deleteEdge("Comment", commentId);
```

- `live.update(type, id, {changed, data})` — entity field change. **Publish the re-resolved entity inline as `data`.** The mutation already re-resolved it for its own response ([fate-effect-operations.md](./fate-effect-operations.md)), so the live event carries resolved data and each client masks it to its own selection. The DO does no database work and needs no Effect runtime.
- `live.topic(name | "Type.field", args?).appendNode/prependNode/deleteEdge/invalidate(...)` — list membership. Pass the resolved `node` inline.
- Topic identity strips pagination args, keeps filter args — `live.topic("posts")` reaches every feed-sort variant; `live.topic("Post.comments", {id})` targets one post's comments.

This is why connection membership is server-driven ([fate-mutations-client.md](./fate-mutations-client.md)): one publish updates every subscribed client, instead of each client patching its own cache.

**Testing a publishing mutation end-to-end:** one `integration` case in `tests/integration/fate-live.test.ts` subscribes to a topic the mutation publishes to and asserts the frame arrives — the sozluk `definition.add` → args-scoped `Term.definitions` `appendNode` case is the reference.

### Publishing from a domain-service seam — one publish, every caller live {#service-seam-publish}

The publish need not live in the mutation handler. When *many* write paths must all produce the same live signal, publish from the **domain service** they all call, once — every caller inherits liveness with zero per-caller publish code. The bildirim spine is the reference (#1700): `Notification.record`/`recordAggregate` publish the recipient's fresh unread count from *inside* the service, so every emitter (rite, reply, vote, mod) is live without touching the publish. The service method takes `LivePublisher` in its `R` channel (`Effect<A, never, LivePublisher>`); its callers are fate handlers, which already carry the per-request publisher, so the requirement discharges at the call site with no new wiring. The publish stays fire-and-forget after the committed write — `LivePublisher`'s methods are `Effect<void>` (swallow-with-log, [ADR 0039](../.decisions/0039-livebus-context-service.md)) — so it can never fail the write.

### Recipient-scoped live channels — the topic authorization gate {#recipient-scoped-channels}

A per-recipient live signal (a user's own notification unread count, an inbox badge) uses an **entity topic keyed by the recipient's user id** — `live.update("NotificationChannel", recipientId, {data})` fans out on `NotificationChannel:<recipientId>`. The subscriber watches its own channel: `useLiveView(ChannelView, client.ref("NotificationChannel", userId, ChannelView))`.

The security seam is **not** the DO's owner check. The connection DO rejects a subscription that names a *different connection's* owner, but an **entity** subscription's `entityId` is client-supplied — nothing in the DO stops a user from subscribing to `type: "NotificationChannel", entityId: <someone-else's-id>`. So a recipient-scoped entity type MUST be authorized at the `/fate/live` route (`features/fate-live/route.ts`): reject an entity `subscribe` op whose `type` is the recipient-scoped channel and whose `entityId !== session.user.id`, returning `{ok: false}` before the topic registers. Single-source the channel type string in a leaf module both the publish seam and the route import (bildirim's `channel.ts`), so publish and gate can't name different types. The gate is proven at the integration tier: a cross-user subscribe returns `results: [{ok: false}]` (`tests/integration/fate-live-bildirim.test.ts`).

Above-Suspense readers (a topbar badge in the app shell, not inside a `<Screen>`) can't call the suspending `useLiveView`; they drive the live read themselves — seed the ref with one imperative `client.request`, hold `client.subscribeLiveView` open, and read reactively via `useSyncExternalStore` over `client.store.subscribe` (the `useBildirimUnread` shape, mirroring `useView`'s coverage-driven store subscription).

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

**Replay / catch-up buffer.** The topic role retains a **bounded, storage-backed ring buffer** of recently-published frames (KV keys `frame:<topicKey>:<seq>`, `seq` zero-padded so lexical list order = publish order), bounded by **both** count (`maxBufferedFramesPerTopic`) and TTL (`bufferedFrameTtlMs`, a few seconds) and pruned on every `publish` and `register`. It exists to close the **publish-vs-register race** ([#714](https://github.com/kamp-us/phoenix/issues/714)): a mutation's fire-and-forget publish lists the registry **once**, so a subscriber whose `register` RPC hasn't committed yet is missed by fan-out (under load the register RPC stretches to seconds). On `register`, after persisting the row, the topic **replays** the buffered window to the just-registering connection — but **bounded to the register-race window, not the topic's history**. The primary bound is `subscribedAt`: the connection stamps an intent timestamp once at the top of `subscribe` (one reading shared across its topics) and threads it through `register`; replay delivers only frames whose publish time is **at/after** `subscribedAt` (minus a sub-second cross-DO clock grace). Frames published *before* the subscriber expressed intent were already in its initial query result, so replaying them would duplicate a "live" edge — the exact regression a whole-TTL-window replay caused (PR [#728](https://github.com/kamp-us/phoenix/pull/728)). `lastEventId` (threaded the same way) is an *additional* tightening on a cursored resubscribe — skip frames at/under the id already seen — but `subscribedAt` is the primary bound and applies even with no cursor (every production subscriber is cursorless).

The buffer is **storage-backed, not in-memory**: a topic DO is *not* pinned by an open stream (only connection DOs are), so it evicts between a publish and a later register — an in-memory buffer would be gone exactly when replay needs it.

**Dedup guarantee — at-most-once, exclusive-by-construction.** Fan-out (`publish`) delivers only to connections *already* in the registry; replay delivers only to the connection *registering now* — which fan-out could not have reached, because its row wasn't persisted when that publish listed the registry. The two paths are disjoint by the order of the race itself, so a frame is never sent to one connection twice. The fate native client is *also* idempotent under node id (`insertConnectionEdge` strips any prior occurrence before each insert), so even an unforeseen overlap collapses to a single edge — but the primary guarantee is the construction-level exclusivity, documented at the `replayBuffer` seam in `live-do.ts`.

> On reconnect proper (the client closes and reopens the stream), the client resubscribes carrying `lastEventId` and the same replay path catches it up within the TTL window; gaps older than the window reconcile on the next cache read or navigation.

> **On hibernation.** An open SSE stream pins its connection-role `LiveDO` instance in memory. At phoenix's scale that's fine. The escape hatch, if concurrent live connections grow large, is to switch the browser transport to a WebSocket and use the DO WebSocket Hibernation API — a transport swap behind the same bus + topology, not a redesign.

## The publish-only event bus

`createFateServer({live})` still takes a bus value (fate detects a custom bus by `"subscribe" in live`), but phoenix's publish path is the per-request **`LivePublisher` service** ([fate-effect-server.md](./fate-effect-server.md)): the worker's `livePublisherFor` (`worker/features/fate-live/live-publisher.ts`) builds the frames + topic keys directly — the one frame-building code path — over the request's topic publish + `waitUntil`. The bus handed to fate's config (`liveBusConfig`, `worker/features/fate-live/event-bus.ts`) is a minimal `LiveEventBus`-typed stub whose every method throws: nothing ever calls it — fate only runs the `"subscribe" in live` structural check at build time (the SSE protocol is served by the `/fate/live` route + `LiveDO`, not by fate's `handleLiveRequest`, and mutations publish through the per-request service).

```ts
// worker/features/fate-live/event-bus.ts — subscribe-detection only; every method throws
export const liveBusConfig: LiveEventBus = {update: neverPublished, /* … */ subscribe: neverSubscribed, subscribeConnection: neverSubscribed};
```

Each publish resolves the topic keys it targets (`topicsForPublish`, `protocol.ts`) and hands the inline-resolved frame to the publisher. The `/fate` route builds that publisher from the worker-init-resolved `LiveDO` namespace — `LiveTopics.publish(topicKey, message, limits)` fires `live.getByName(\`topic:${key}\`).publish({topicKey, frame, limits})`, fired-and-forgotten via `Cloudflare.WorkerExecutionContext.waitUntil` so it doesn't block the mutation response. No `env`-based lookup, no `idFromName`, no string-URL `stub.fetch` (ADR 0028/0029); no `AsyncLocalStorage` — the publisher is provided per request as a service value (ADR 0039's insight, now living in `LivePublisher`). Wire `createFateServer({live: liveBusConfig})` (done by the fate config — [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md)) and route `/fate/live` to a connection-role `LiveDO` instance.

## Auth {#auth}

The live stream authenticates with the **better-auth session cookie**, same as the data transport ([fate-client-setup.md](./fate-client-setup.md)). fate opens the `EventSource` with `withCredentials: true`, so the session cookie rides the SSE `GET` automatically — no token in the URL, no header. Same-origin (one Worker) makes this work. The Worker validates the cookie with `Pasaport.validateSession` at `GET /fate/live`, before forwarding to the connection-role `LiveDO` instance, and rejects unauthenticated opens. The connection instance records the owner so a control message can't subscribe on another user's behalf.

## DO binding — alchemy-managed

`LiveDO` is the only Durable Object in phoenix. There is no `wrangler.jsonc` and no hand-written `durable_objects` / `migrations` block (ADR 0026–0028): the worker declares the single class as its `Deps` contract — `Cloudflare.Worker<Phoenix, {}, LiveDO>()("phoenix", …)` — and provides `LiveDOLive` ([alchemy-durable-objects.md](./alchemy-durable-objects.md)). alchemy derives the DO migration from the binding (a new DO class defaults to `new_sqlite_classes` under the hood, tracked via worker tags — see [alchemy-stack-deploy.md](./alchemy-stack-deploy.md)), so declaring + providing the class is all it takes. KV storage means there is no SQL migration directory for the registry either.

The DO runs locally under the same `alchemy dev` worker, so there is one live path in every environment.

## See also

- [ADR 0023](../.decisions/0023-live-views-sse-livedo.md) — the SSE transport, DO fan-out, cookie auth, and `generation` decisions (amended-in-part by 0037; the SSE/fan-out/auth semantics stand unchanged)
- [ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md) — why the split `ConnectionDO`/`TopicDO` pair was reunified into one void-aligned `LiveDO` (supersedes 0025, retires 0033)
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the unified `LiveDO` recipe (`.make()`, role dispatch, KV, the alarm)
- [fate-effect-operations.md](./fate-effect-operations.md) — where `live.*` is published, and the inline re-resolution
- [fate-mutations-client.md](./fate-mutations-client.md) — connection membership driven by these events
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `useView`/`useListView` the live hooks mirror
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — mounting the fate server and the `live` bus config
- void reference (in the [fate](https://github.com/usirin/fate) repo): `packages/void-fate/src/server.ts`, `example/void/src/fate/live.ts`, and void's `createLiveDurableObject` (the DO template)
- fate live internals: `packages/fate/src/server/live.ts` (`LiveEventBus`), `liveTopics.ts`, `protocol.ts` (live message types)
