# Durable Objects

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

How phoenix's live fan-out DO is written on alchemy. The short answer:
`LiveDO` is a single `Cloudflare.DurableObject<LiveDO, LiveRpcSurface>()("LiveDO")`
class (identity + RPC contract, no inline body) with a separate `LiveDOLive`
implementation Layer produced by `LiveDO.make(body)`. `body` is a two-phase
Effect — an outer constructor phase, then a per-instance Effect that yields
`Cloudflare.DurableObjectState` and returns handlers. Methods you return become
**typed RPC** the worker (and the DO itself) calls through a stub; `fetch`
handles request-shaped interactions like the SSE upgrade. KV storage and alarms
are Effect-wrapped.

phoenix has exactly **one** DO. `LiveDO` (`worker/features/fate-live/live-do.ts`)
plays **both** the connection role and the topic role, distinguished by
instance-name prefix — a void-aligned rewrite of the former split
`ConnectionDO`/`TopicDO` pair ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md)
supersedes [0025](../.decisions/0025-split-livedo-connection-topic.md)).

> **One class, two roles — no sibling cycle.** A `LiveDO` instance is named
> `connection:<id>` or `topic:<key>`; `resolveRole(state.id.name)` picks the role
> at request time. Cross-role calls (connection→topic register, topic→connection
> deliver) ride the DO's **OWN** namespace, resolved **once in the outer init**
> via the beta.59 self-scope — `yield* Cloudflare.DurableObject` — and held in
> the closure; not a sibling DO Tag, not `LiveDO.from(Self)` (which needs the
> host `Worker` import and would reintroduce the worker↔DO cycle), and not a
> per-call resolution. The self-scope service is not a member of
> `DurableObjectServices`, so `.make` leaves it in the Layer's `Req` even though
> the bridge provides it at runtime — a phantom requirement discharged with one
> localized double cast at the yield site. The whole story (what beta.59 removed,
> why the alternatives fail, why the cast is sound) is
> [ADR 0124](../.decisions/0124-livedo-self-addressing-beta59-runtime-scope.md),
> amending 0037; the mutual-DO per-call rule of
> [ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)
> stays retired. The Layer is `Layer<LiveDO, never, Worker>`.

## The shape

The DO splits into three pieces: the RPC surface type, the class Tag (no body),
and the implementation Layer.

```ts
// worker/features/fate-live/live-do.ts
import type {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// (1) RPC surface — both roles' methods. beta.59 colors DO storage and
// cross-DO stubs with `RuntimeContext`, so every method's R is `RuntimeContext`
// (ADR 0124) — discharged at the worker call seam and, in unit tests, via
// `RuntimeContext.phantom`.
export interface LiveRpcSurface {
  readonly subscribe: (input: /* … */) => Effect.Effect<{ok: boolean}, never, RuntimeContext>;
  readonly unsubscribe: (input: /* … */) => Effect.Effect<{ok: true}, never, RuntimeContext>;
  readonly deliver: (input: /* … */) => Effect.Effect<DeliverResult, never, RuntimeContext>;
  readonly check: (input: /* … */) => Effect.Effect<{stale: ReadonlyArray<number>}, never, RuntimeContext>;
  readonly register: (input: /* … */) => Effect.Effect<{ok: boolean}, never, RuntimeContext>;
  readonly unregister: (input: /* … */) => Effect.Effect<{ok: true}, never, RuntimeContext>;
  readonly publish: (input: /* … */) => Effect.Effect<{delivered: number}, never, RuntimeContext>;
}

// (2) Class Tag — identity + contract, no body. Importing this pulls in no DO
// runtime (the bundler tree-shakes `.make()` out of consumers).
export class LiveDO extends Cloudflare.DurableObject<LiveDO, LiveRpcSurface>()("LiveDO") {}

// (3) Implementation Layer.
export const LiveDOLive = LiveDO.make(
  Effect.gen(function* () {
    // ── OUTER INIT (the constructor phase) ──
    // Resolve the DO's OWN namespace here for cross-role addressing — the
    // beta.59 self-scope yield. It MUST be here, not in a handler: the bridge
    // provides the self-scope to the constructor phase only, never to the inner
    // handlers. The double cast discharges the phantom `Req` the `.make` typing
    // leaves behind (ADR 0124) — no value is fabricated, the runtime yield is
    // unchanged.
    const live = yield* Cloudflare.DurableObject as unknown as Effect.Effect<LiveNamespace>;

    // The outer gen RETURNS the per-instance Effect. `return yield*` would
    // collapse the two phases — see below.
    // @effect-diagnostics-next-line effect/returnEffectInGen:off
    return Effect.gen(function* () {
      // ── PER-INSTANCE ──
      const state = yield* Cloudflare.DurableObjectState;
      const instance = makeLiveInstance(state, live); // state + self-namespace
      return {
        fetch: /* SSE upgrade, request-shaped — opens the held stream */,
        subscribe: instance.subscribe,
        unsubscribe: instance.unsubscribe,
        deliver: instance.deliver,
        check: instance.check,
        register: instance.register,
        unregister: instance.unregister,
        publish: instance.publish,
        alarm: instance.alarm,
      };
    });
  }),
);
```

Both phases run on each instance wake, sequentially, inside
`state.blockConcurrencyWhile` (`alchemy@2.0.0-beta.59 —
src/Cloudflare/Workers/DurableObjectBridge.ts`: the bridge constructor runs the
outer Effect, then the inner Effect it returned) — the outer phase is *not*
once-per-namespace. The distinction is what each phase can see: only the outer
(constructor) phase gets the self-scope; the inner phase yields
`Cloudflare.DurableObjectState` and closes over per-instance values — this
closure is alchemy's equivalent of instance fields and persists for the
instance's lifetime. `return Effect.gen(...)` returns the inner Effect **unrun**
so the bridge invokes it in the right phase; `return yield* Effect.gen(...)`
would run it during the constructor phase with the wrong services in scope. The
`effect/returnEffectInGen:off` suppression is correct here — annotate with
**why**.

## Role dispatch: `resolveRole(state.id.name)`

The role is the instance name's prefix (void's convention):

```ts
function resolveRole(name: string | undefined): Role {
  if (name?.startsWith("connection:")) return {kind: "connection", connectionId: name.slice(11)};
  if (name?.startsWith("topic:"))      return {kind: "topic", topicKey: name.slice(6)};
  return {kind: "unknown"};
}
```

`makeLiveInstance(state, live)` computes the role once and each method branches on
it. A misrouted call (e.g. `register` on a `connection:` instance) hits an
instance whose role doesn't match and returns a harmless no-op result — void has
no role guard either. The trade-off vs the old split (cross-role misroutes were
*unrepresentable* at the type level) is recorded in
[ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md).

## RPC methods instead of fetch-path dispatch

The DO returns **named methods** — each becomes a typed RPC on the stub. No
manual `url.pathname` routing, no request/response (de)serialization:

```ts
// caller (worker, or the DO's own init closure for cross-role addressing)
yield* topicOf(live, topicKey).publish({topicKey, frame, limits});
yield* connectionOf(live, connectionId).deliver({frame, row, limits});
```

Reserve `fetch` for the genuinely request-shaped interaction — the SSE upgrade.
Everything else (`subscribe`, `register`, `publish`, `check`, …) is a method.

## The typed error channel is a type lie — retry the cold-start transport seam

Every `LiveRpcSurface` method above declares failure channel `never`, but that
`never` is the **declared** shape, not the **runtime** one. The alchemy stub
(`makeRpcStub`, `src/Cloudflare/Workers/Rpc.ts`) wraps each cross-DO call in
`Effect.tryPromise({catch: … RpcCallError})`, so a real transport failure —
crucially a **cold-start** race when Cloudflare has evicted an idle DO — surfaces as
an `RpcCallError` in the failure channel the static type erases. A bare call or an
`Effect.orDie` therefore turns a sub-second warm window into a defect → an
unrecoverable HTTP 500 (the steady-state path for the global live pin against an idle
`topic:User:<id>` DO).

The fix wraps each stub call at the one seam where the runtime error is reachable — the
worker `index.ts` `liveLayer` call sites.
`apps/web/worker/features/fate-live/cold-start-retry.ts` owns `withColdStartRetry(method,
call)`: it reinterprets the type-lie `never` to the runtime reality, retries with capped
exponential backoff, and on exhaustion surfaces a typed `LiveTransportError` the route
renders as a graceful 503. The retry keys on the `RpcCallError` `_tag` (a structural tag
check — the class is internal to alchemy), so a **genuine app error fails fast and passes
through untouched**. The SSE-open path is the one exception: a cold-DO `stub.fetch`
rejection arrives as a **defect**, not an `RpcCallError` failure, so the open call site
uses the sibling `withColdStartRetryFetch`, which lifts the transport defect into the same
retryable shape. Why the cold-start race is the steady state, and the retryable-only
schedule shape (grounded in effect-smol `LLMS.md`), live in
[ADR 0095](../.decisions/0095-cold-start-retry-rpc-transport-seam.md) and
[ADR 0094](../.decisions/0094-app-lifetime-global-live-pin.md).

```ts
// index.ts liveLayer — wrap each stub call at the seam, never call it bare:
subscribe: (id, input) =>
  withColdStartRetry("subscribe", connectionOf(live, id).subscribe(input)),
open: (id, request) =>
  withColdStartRetryFetch("open", connectionOf(live, id).fetch(request)),
```

The service `Context.Service` signatures (`topics.ts`) then declare the truthful
`LiveTransportError` channel instead of the erased `never`, so the route is forced
to handle the 503 path — invalid state (a swallowed transport failure) made
unrepresentable.

## Addressing: `getByName` only, through the name-grammar helpers

The alchemy DO namespace exposes **only `getByName(name)`** (plus the stub's
typed methods and `fetch(HttpServerRequest)`). `idFromName`, `idFromString`,
`get`, `newUniqueId`, and `jurisdiction` are unavailable — they exist commented
out in the binding construction (`alchemy@2.0.0-beta.59 —
src/Cloudflare/Workers/DurableObject.ts`, the runtime namespace object). All
addressing is name-based — and for `LiveDO` the name *is* the role + key, so
production code addresses instances only through the exported helpers that fuse
the name grammar with `getByName`:

```ts
const topic = topicOf(live, topicKey);              // getByName(`topic:${topicKey}`)
const connection = connectionOf(live, connectionId); // getByName(`connection:${connectionId}`)
```

A hand-rolled malformed name resolves to role `unknown` — a silently no-op RPC —
so "always address via `connectionOf`/`topicOf`" is the greppable convention.
The `generation` stale model holds under name addressing: the only handle is the
human-readable `connection:${id}` key, so the topic registry stores and re-derives
that key, and `generation`+`revision` carry the staleness — no opaque id is needed.

## KV storage (no SQLite)

Storage is `state.storage`'s KV API, mirroring void's flat keys — there is no SQL
table and no `@effect/sql-sqlite-do`. The storage methods are
`RuntimeContext`-colored (beta.59): resolve the `state` *reference* wherever, but
call `storage.get`/`put`/`list`/`delete` only where `RuntimeContext` is in scope —
the per-instance handlers.

- **Subscriber rows** (topic role) — keyed
  `sub:${topicKey}:${connectionId}:${subId}:${generation}:${revision}` → the
  `SubscriberRow` value. Read with `state.storage.list({prefix: "sub:${topicKey}:"})`;
  batch-delete with `state.storage.delete(keys)`.
- **The per-connection generation scalar** (connection role) —
  `state.storage.get<number>("connection:generation")` / `put`. Bumped on every
  (re)connect; survives eviction, so a reconnect after eviction lands strictly
  higher than any stale row a topic still holds.

```ts
// topic role — list a topic's subscriber rows
const entries = yield* Effect.map(
  state.storage.list<SubscriberRow>({prefix: `sub:${topicKey}:`}),
  (map) => [...map],
);
```

## Per-subscriber `frame.id` at delivery

One `publish` fans out to many subscriptions. The publish frame's `id` is left
empty; the **topic** instance stamps each delivered frame's `id` from the
subscriber row at delivery (`{...input.frame, id: item.row.subId}`), so every
subscriber sees its own fate subscription id from a single publish.

## Holding the SSE stream (connection role)

The connection role holds a `Queue` of frames merged with a 15s keep-alive tick,
returned as a streaming `HttpServerResponse`. The open stream pins the DO in
memory (no hibernation):

```ts
const queue = yield* Queue.unbounded<Uint8Array>();
const keepAlive = Stream.tick("15 seconds").pipe(
  Stream.drop(1),                       // skip the immediate tick; first keep-alive at +15s
  Stream.map(() => KEEPALIVE_FRAME),
);
const merged = Stream.merge(Stream.fromQueue(queue), keepAlive).pipe(Stream.ensuring(closeStream));
return HttpServerResponse.stream(merged, {headers: SSE_HEADERS});
```

`deliver` offers an encoded frame onto the queue (with backpressure: a connection
too far behind is closed and the row treated as stale). See
[effect-sse-externally-driven.md](./effect-sse-externally-driven.md) for the
queue + keep-alive shape in isolation.

> **No WebSocket hibernation here.** `LiveDO` holds an HTTP SSE stream, not a
> WebSocket, so the hibernation API doesn't apply. For DOs that *do* use
> WebSockets, alchemy provides `Cloudflare.upgrade()`, `serializeAttachment` /
> `deserializeAttachment`, and the `webSocketMessage` / `webSocketClose` handler
> slots (`src/Cloudflare/Workers/DurableObject.ts` §WebSocket Hibernation, and
> the bridge's `webSocketMessage`/`webSocketClose` forwarding). phoenix doesn't
> need them today.

## The reap alarm (topic role)

The topic role schedules a 60s alarm that probes each subscriber's connection via
`check` and reaps stale rows. The reap is **first-failed-probe** — void-faithful,
no consecutive-miss counter:

```ts
const register = (input) =>
  Effect.gen(function* () {
    // … supersede this connection's older-generation + prior-revision rows …
    yield* state.storage.put(subscriberKey(row), row);
    yield* ensureAlarm;                 // setAlarm(now + 60s) if none scheduled
    return {ok: true};
  });

const alarm = () =>
  Effect.gen(function* () {
    const entries = yield* loadRows(role.topicKey);    // grouped by connectionId
    for (const [connectionId, items] of grouped) {
      const result = yield* connectionOf(live, connectionId)
        .check({subscriptions: items.map((i) => i.row)})
        .pipe(Effect.timeout(probeTimeout), Effect.catchCause(() => Effect.succeed(undefined)));
      if (result === undefined) {
        // FIRST failed probe → reap ALL this connection's rows (no miss counter)
        staleKeys.push(...items.map((i) => i.key));
      } else {
        for (const index of result.stale) staleKeys.push(items[index].key);
      }
    }
    if (staleKeys.length > 0) yield* state.storage.delete(staleKeys);
    // reschedule while rows remain (reap an evicted connection's orphans even
    // with no publish traffic)
    if ((yield* loadRows(role.topicKey)).length > 0)
      yield* state.storage.setAlarm(Date.now() + 60_000);
  });
```

`publish` mirrors the same reap inline: a topic→connection `deliver` that can't be
reached (timeout / defect) flips `reachable` and reaps ALL that connection's rows
for the topic. The per-probe `Effect.timeout` keeps one unreachable connection
from stalling the single-threaded DO.

## Where the body lives — unit-testable

`makeLiveInstance(state, live)` holds the per-instance algorithm and takes the
resolved state + the self-namespace as plain args — typed against `LiveDoState`,
the `Pick<…, "id" | "storage">` slice of `DurableObjectState` it actually touches
— so a node-pool unit test drives it without workerd (inject a fake state + a
fake namespace whose `getByName` returns stubs; discharge the methods'
`RuntimeContext` with `RuntimeContext.phantom`). See
`features/fate-live/do.test.ts` for the unit driver and
`tests/integration/fate-live.test.ts` for the black-box-over-HTTP version.

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — `yield* SomeDO` and the binding
  model
- [alchemy-http-router.md](./alchemy-http-router.md) — the `/fate/live` route
  that forwards to a `connection:` instance
- [fate-live-views.md](./fate-live-views.md) — the live protocol and the DO in
  the wider live picture
- [effect-sse-externally-driven.md](./effect-sse-externally-driven.md) — the
  held-stream queue + keep-alive shape
- [ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md) — why one
  unified `LiveDO` (supersedes the 0025 split, retires the 0033 mutual-DO rule)
- [ADR 0124](../.decisions/0124-livedo-self-addressing-beta59-runtime-scope.md) —
  the beta.59 self-namespace resolution + phantom-`Req` discharge
