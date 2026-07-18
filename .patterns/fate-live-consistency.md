# Live view consistency — why a view goes stale, and the self-heals

> Derived from `@nkzw/fate@1.3.1` — re-verify on pin bump.

A live view is only as current as the events that reach it, and v1 live is best-effort: the publish is fire-and-forget, there is no server-side replay beyond a few seconds, and a lost frame is *lost, not late*. This doc explains the ways a live view falls out of sync and the invariants and self-heals that keep it consistent. The machinery these reference — the SSE transport, the `LiveDO` roles, the replay buffer — is described in [fate-live-views.md](./fate-live-views.md); the authoring recipe that publishes an invalidation is in [fate-live-publishing.md](./fate-live-publishing.md).

Two failures are structural (the stream tearing down under mutation churn, and the publish-vs-register race), and one is authorial (a mutation that writes but forgets to publish). The first two are self-healed transport-side; the third is guarded by the invalidation invariant below.

## One app-lifetime global live pin keeps the stream alive {#global-pin}

A page whose only live subscription is a `useLiveListView` would otherwise lose a just-published `appendNode`/`prependNode` after a write mutation. The native client refcounts the one shared `EventSource`: `remove()` runs `if (operations.size === 0) { source.close(); nativeLiveClient = undefined }`, and the next subscribe rebuilds a fresh stream with a new random `connectionId`. `useLiveListView`'s subscribe effect re-keys on the connection's `metadata.key`, which goes transiently null during the in-flight refetch a mutation triggers (`useRequest` hands the connection back as a bare array, no `ConnectionTag`). In that window the lone subscription unsubscribes → refcount hits 0 → the stream closes → the mutation's fire-and-forget publish ([the publish-only event bus](./fate-live-views.md#the-publish-only-event-bus)) targets the now-dead `connectionId` and is dropped (v1 live is best-effort, no replay). The live event is **lost, not late**, so the new row never appears until a manual refresh.

The fix holds **one always-on live subscription for the whole authenticated session**, so `operations.size` is structurally never 0 while the app is mounted — fate's `source.close()` branch can't fire during mutation churn, the `EventSource` + `connectionId` stay stable, and every publish lands on a live connection ([ADR 0094](../.decisions/0094-app-lifetime-global-live-pin.md)). `apps/web/src/fate/useGlobalLivePin.ts` exposes `useGlobalLivePin(userId)`; `FateProvider` mounts it (gated on a non-null session user id) once, above the router, inside the `FateClient` context.

The anchor is the viewer's **own `User` row**, keyed on the better-auth session id: always valid for an authenticated session (`User.id === CurrentUser.id`, the same id the `me` query resolves) and the lightest possible — a single entity-field subscription, no list/connection fan-out, no pagination churn. It never fires for an anonymous client (the caller gates on `userId != null`; an anon `EventSource` 401-loops). It releases on sign-out/unmount, so the stream tears down cleanly when the app leaves (leaking the connection is the opposite failure). This makes the transient-0-refcount state unrepresentable for every authenticated live view at once, so no per-view pin is needed; the transport-level invariant is unit-proved in `apps/web/src/fate/globalLivePin.test.ts` (with the pin removed the EventSource is torn down — the falsification baseline).

## The mutator's own view never waits on a push {#read-back}

The global pin above keeps the stream alive across churn, but a second, load-driven loss remains: the create-mutation's fire-and-forget publish ([the publish-only event bus](./fate-live-views.md#the-publish-only-event-bus)) fans out to the topic `LiveDO`, which lists its subscriber rows **once** — if the subscriber's `register` RPC hasn't persisted yet, the fan-out set is empty and the `appendNode` delivers to nobody (no v1 replay). Under load the subscribe `register` slows from ~200ms to seconds, so the publish loses the race on nearly every late write and the mutator's own view waits on a push that never arrives — the new node never appears until a manual refresh (#714 diagnosis on epic #713; #711 is the durable transport-side fix).

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
a new mutation forces the fanned/not decision; this section is the *why* behind the guard. The
recipe the guard expects — how to actually wire the publish — is in
[fate-live-publishing.md](./fate-live-publishing.md#reference-pattern).

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
followed the write. The fix is always the [reference pattern](./fate-live-publishing.md#reference-pattern):
after the write, publish the reconcile through the feature's `live.ts`.

## See also

- [fate-live-views.md](./fate-live-views.md) — the reference: the SSE transport, the `LiveDO` roles, the replay/dedup buffer these self-heals lean on
- [fate-live-publishing.md](./fate-live-publishing.md#reference-pattern) — the how-to: the recipe that discharges the invalidation invariant
- [ADR 0094](../.decisions/0094-app-lifetime-global-live-pin.md) — the app-lifetime global live pin
- [ADR 0155](../.decisions/0155-fanned-mutation-publish-guard.md) — the fanout-guard that enforces the invalidation invariant
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `useView`/`useListView` and the remount-no-refetch gotcha the read-back works around
