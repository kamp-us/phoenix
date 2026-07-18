# How to make a mutation publish its live invalidation

> Derived from `@nkzw/fate@1.3.1` — re-verify on pin bump.

You have written a `Fate.mutation` that writes an entity or list backing a `/fate/live` view, and every subscribed client must reflect the change without a manual reload. This is the recipe: after the write, publish the invalidation through the feature's `live.ts`. The publish API surface it calls is in [fate-live-views.md](./fate-live-views.md#server); *why* the publish is mandatory (and what breaks when you skip it) is in [fate-live-consistency.md](./fate-live-consistency.md#invalidation-invariant).

Start here whenever you add or change a mutation over `Post` / `Comment` / `Definition` — or any entity a live view subscribes to.

## The recipe — how pano + sözlük publish {#reference-pattern}

The landed features (`features/pano/mutations.ts`, `features/sozluk/mutations.ts`) all follow one shape. Copy it:

1. **Acquire the publisher and bind the feature's `live.ts` targets.** Each feature owns a single `live.ts` — the ONE place that answers "what does mutating this entity publish to?" It binds the entity's wire `__typename` **off the view's `typeName`**, never an inline `"Post"`/`"Definition"` literal ([#1127](https://github.com/kamp-us/phoenix/issues/1127)):

   ```ts
   // features/sozluk/live.ts — const DEFINITION = DefinitionView.typeName;
   const live = sozlukLive(yield* WorkerLivePublisher);
   ```

   The view is the source of the typename, so a resolver names the fan-out target instead of restating the magic-string seam — and the published frame is byte-identical to the inline wiring it replaced.

2. **Publish after the write.** Pick the shape by what changed:
   - **Scalar field reconcile** — `live.<entity>.update(id, {changed, data})`. Pass the re-resolved entity inline as `data` (the mutation already re-resolved it for its own response); each client masks it to its own selection. `changed` is a per-mutation hint (which fields the write touched) and does not reach the wire.

     ```ts
     yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
     ```
   - **Connection membership** — a topic `appendNode` / `prependNode` / `deleteEdge` on the args-scoped connection the view subscribes to (`Term.definitions` keyed by term slug, `Post.comments` keyed by post id, the global `posts` feed):

     ```ts
     yield* live.definition
       .term(input.termSlug)
       .appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt));
     ```

3. **`broadcastIf`-gate any node broadcast to a viewer-blind topic.** `appendNode` / `prependNode` push a node onto a public topic that has no per-subscriber view of the viewer, so a resolver cannot broadcast without discharging the sandbox `PublishDecision` ([#1280](https://github.com/kamp-us/phoenix/issues/1280); the `broadcastIf` gate in each feature's `live.ts`). `deleteEdge` / `update` carry no broadcast node, so they stay ungated.

For a delete, publish symmetrically: `live.<entity>.delete(id)` for the entity plus a topic `deleteEdge(id)` on the connection it leaves, and its inverse (`restore`) re-publishes the `appendNode` through the same sandbox gate — see `definition.delete` / `definition.restore` in `features/sozluk/mutations.ts`.

## Publishing from a domain-service seam — one publish, every caller live {#service-seam-publish}

The publish need not live in the mutation handler. When *many* write paths must all produce the same live signal, publish from the **domain service** they all call, once — every caller inherits liveness with zero per-caller publish code. The bildirim spine is the reference (#1700): `Notification.record`/`recordAggregate` publish the recipient's fresh unread count from *inside* the service, so every emitter (rite, reply, vote, mod) is live without touching the publish. The service method takes `LivePublisher` in its `R` channel (`Effect<A, never, LivePublisher>`); its callers are fate handlers, which already carry the per-request publisher, so the requirement discharges at the call site with no new wiring. The publish stays fire-and-forget after the committed write — `LivePublisher`'s methods are `Effect<void>` (swallow-with-log, [ADR 0039](../.decisions/0039-livebus-context-service.md)) — so it can never fail the write.

## Recipient-scoped live channels — the topic authorization gate {#recipient-scoped-channels}

A per-recipient live signal (a user's own notification unread count, an inbox badge) uses an **entity topic keyed by the recipient's user id** — `live.update("NotificationChannel", recipientId, {data})` fans out on `NotificationChannel:<recipientId>`. The subscriber watches its own channel: `useLiveView(ChannelView, client.ref("NotificationChannel", userId, ChannelView))`.

The security seam is **not** the DO's owner check. The connection DO rejects a subscription that names a *different connection's* owner, but an **entity** subscription's `entityId` is client-supplied — nothing in the DO stops a user from subscribing to `type: "NotificationChannel", entityId: <someone-else's-id>`. So a recipient-scoped entity type MUST be authorized at the `/fate/live` route (`features/fate-live/route.ts`): reject an entity `subscribe` op whose `type` is the recipient-scoped channel and whose `entityId !== session.user.id`, returning `{ok: false}` before the topic registers. Single-source the channel type string in a leaf module both the publish seam and the route import (bildirim's `channel.ts`), so publish and gate can't name different types. The gate is proven at the integration tier: a cross-user subscribe returns `results: [{ok: false}]` (`tests/integration/fate-live-bildirim.test.ts`).

Above-Suspense readers (a topbar badge in the app shell, not inside a `<Screen>`) can't call the suspending `useLiveView`; they drive the live read themselves — seed the ref with one imperative `client.request`, hold `client.subscribeLiveView` open, and read reactively via `useSyncExternalStore` over `client.store.subscribe` (the `useBildirimUnread` shape, mirroring `useView`'s coverage-driven store subscription).

## See also

- [fate-live-views.md](./fate-live-views.md#server) — the publish API surface (`live.update` / `live.topic` signatures) this recipe calls
- [fate-live-consistency.md](./fate-live-consistency.md#invalidation-invariant) — why the publish is mandatory: the invalidation invariant and the stale-til-reload anti-pattern
- [fate-effect-operations.md](./fate-effect-operations.md) — write conventions: where in a handler the publish belongs, and the inline re-resolution
- [caylak-content-containment.md](./caylak-content-containment.md) — the `PublishDecision`/`decidePublish` sandbox gate the `broadcastIf` step discharges
