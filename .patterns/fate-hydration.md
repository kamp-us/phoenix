# Hydration — snapshot & restore the normalized cache

> Derived from `@nkzw/fate@1.3.1` — re-verify on pin bump.

How the client's normalized cache leaves memory and comes back. The short answer: `FateClient.dehydrate()` exports the durable cache as a versioned, JSON-safe snapshot; `hydrate(state)` restores it into a fresh client **before anything renders**. Built for SSR transfer, it is equally the substrate for client-side persistence — persist a snapshot at page-hide, hydrate at boot, and the last-seen screen paints synchronously with no pending state. The one non-obvious thing: **both directions refuse a busy client** — `dehydrate()` and `hydrate()` each throw while requests are pending or optimistic updates are active, so hydration is strictly a boot-time (or quiesced) act.

## The API surface

```tsx
// export — a versioned, JSON-safe value (FateDehydratedState, version: 1)
const snapshot = fate.dehydrate();

// restore — into a client with the SAME hydrationScope, before rendering
fate.hydrate(snapshot);                       // merge: 'preserve-existing' (default)
fate.hydrate(snapshot, {merge: "replace"});   // snapshot wins over existing cache values
```

- `dehydrate(): FateDehydratedState` — the durable normalized cache (records, selected-field coverage, root queries, root-list state) encoded as plain serializable values. **Treat it as opaque**: transport/store it whole, hydrate it through fate — never read or edit its internals (the fate docs, `docs/guide/requests.md` §SSR and Hydration).
- `hydrate(state, options?)` — validates `version === 1` and the hydration scope, then decodes into the cache. Replaying the same snapshot is safe (idempotent). `merge: 'preserve-existing'` keeps browser values and list windows on conflict; `'replace'` treats the snapshot as authoritative.
- Both throw on: pending requests, active optimistic updates, a version other than `1`, a scope mismatch (`hydrate` only for the latter two).

## The contract: hydrate before the first `useRequest`

Hydration must complete **before rendering components that call `useRequest`** — the canonical shape from the fate docs (`docs/guide/requests.md`), adapted:

```tsx
const fate = createFateClient();
fate.hydrate(persistedSnapshot);   // BEFORE any render/useRequest

root.render(
  <FateClient client={fate}>
    <App />
  </FateClient>,
);
```

Once hydrated, `cache-first` requests **resolve from the normalized cache without refetching**. For a persisted-snapshot boot that wants freshness too, pair with `stale-while-revalidate` (see [the composition idiom](#paint-from-snapshot--revalidate) below).

Because both directions refuse an in-flight client, a *synchronous* storage read is the natural fit for boot-time restore (`localStorage`, not IndexedDB) — an async restore races the first render's requests and gets rejected.

## What hydration restores — and deliberately doesn't

Restores: **records, selected-field coverage, root queries, and list pagination state** (a hydrated feed knows which pages it had; connection identity — filter args kept, pagination args stripped — comes back with it).

Intentionally excluded, by both `dehydrate` and `hydrate`: **active requests, subscriptions, retainers, timers, and optimistic mutation state.** A hydrated client re-subscribes live views and re-issues requests as components mount; nothing runtime-shaped survives the snapshot.

## `hydrationScope` — snapshots are schema-scoped

A snapshot carries a scope string and is **rejected by a client with a different scope**. Generated clients derive a stable default scope from their `roots` + `types`; when constructing a client directly, pass `hydrationScope` and **rotate it when the cache schema changes incompatibly** (or to separate cache namespaces):

```tsx
const fate = createClient({hydrationScope: "storefront-v2", /* … */});
```

Rotation is the invalidation lever for persisted snapshots: bump the scope, and every stale snapshot on every device silently stops hydrating (a scope mismatch throws — a persistence layer catches it and boots cold).

## `HydrationLimits` — resource bounds on encode/decode

Encoding and decoding both enforce limits (fate source, `packages/fate/src/hydration.ts`), configurable per client via the `createClient` option `hydrationLimits` (partial override; each value must be a positive integer):

| Limit | Default | Bounds |
|---|---|---|
| `maxCollectionLength` | 100 000 | entries in any encoded array/object |
| `maxNodes` | 250 000 | total encoded values in a snapshot |
| `maxStringLength` | 1 000 000 | one string, object key, or bigint payload |

Depth is fixed at 64 (not configurable). Exceeding a limit **throws** — a persistence layer must treat an oversized snapshot as a failed save/restore and degrade to a cold boot, never crash the app.

## Paint-from-snapshot + revalidate {#paint-from-snapshot--revalidate}

The composition that makes reload instant: boot-time `hydrate()` + `stale-while-revalidate` on the screen's request ([fate-views-and-requests.md](./fate-views-and-requests.md#request-modes--cache-lifetime)). The hydrated cache satisfies the request synchronously (no suspend, no skeleton), the mode's network leg fetches fresh data in the background and patches the store, and live views re-subscribe on top. The residual reload floor is JS boot itself.

Sharp edges for a persistence layer built on this:

- **Snapshots are point-in-time and per-user.** An authed snapshot embeds viewer-scoped values; key persisted snapshots per identity and drop them on sign-out/identity change — never hydrate one identity's snapshot under another (or under anon).
- **Save at quiesce, not per-render.** `dehydrate()` throws while requests/optimistic updates are in flight, so persist on `pagehide`/`visibilitychange` (throttled), and treat a throw as "skip this save".
- **Tolerate every failure by booting cold.** Corrupt payload, quota, scope mismatch, version bump, limit overflow — all degrade to "no snapshot"; none may block the boot.

## Status in phoenix

Not yet wired — this doc is the grounding for the instant-reload epic [#2316](https://github.com/kamp-us/phoenix/issues/2316): child [#2319](https://github.com/kamp-us/phoenix/issues/2319) (public/anon client persistence) and child [#2321](https://github.com/kamp-us/phoenix/issues/2321) (identity-scoped authed persistence + teardown) are the intended consumers. The two-tier provider ([fate-client-setup.md](./fate-client-setup.md)) is the frame: the always-anon public client and the identity-keyed authed client each hydrate at their own creation site, preserving the #438 no-re-key guard.

## See also

- [fate-views-and-requests.md](./fate-views-and-requests.md) — request modes (`stale-while-revalidate`) & cache lifetime
- [fate-client-setup.md](./fate-client-setup.md) — the client instances a snapshot hydrates into
- [fate-live-views.md](./fate-live-views.md) — live subscriptions (excluded from snapshots, re-established after hydrate)
- fate reference (in the [fate](https://github.com/usirin/fate) repo): `docs/guide/requests.md` §SSR and Hydration, `packages/fate/src/hydration.ts`, `packages/fate/src/client.ts` (`dehydrate`/`hydrate`)
