# Durable Objects

How phoenix's live fan-out DO is written on alchemy. The short answer:
`LiveDO` is a single `Cloudflare.DurableObjectNamespace<LiveDO, LiveRpcSurface>()("LiveDO")`
class (identity + RPC contract, no inline body) with a separate `LiveDOLive`
implementation Layer produced by `LiveDO.make(body)`. `body` is a two-phase
Effect — shared init, then a per-instance Effect that yields
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
> deliver) ride the DO's **OWN** namespace, resolved **once in shared init** via
> `LiveDO.from("phoenix")` and held in the closure — not a sibling DO Tag, and
> not a per-call resolution. Because the class references its own namespace by
> host script name, there is no circular Layer dependency: `.from(scriptName)`
> resolves to `Effect<…, never, Worker>`, so `LiveDOLive` is
> `Layer<LiveDO, never, Worker>` and every RPC method's `R` is `never`. This is
> what retired [ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)
> (the mutual-DO problem) and deleted the sibling-resolution pattern.

## The shape

The DO splits into three pieces: the RPC surface type, the class Tag (no body),
and the implementation Layer.

```ts
// worker/features/fate-live/live-do.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// (1) RPC surface — both roles' methods. Every method's R is `never`: cross-role
// calls ride the self-namespace captured in init, not a per-call Tag.
export interface LiveRpcSurface {
  readonly subscribe: (input: /* … */) => Effect.Effect<{ok: boolean}, never, never>;
  readonly unsubscribe: (input: /* … */) => Effect.Effect<{ok: true}, never, never>;
  readonly deliver: (input: /* … */) => Effect.Effect<DeliverResult, never, never>;
  readonly check: (input: /* … */) => Effect.Effect<{stale: ReadonlyArray<number>}, never, never>;
  readonly register: (input: /* … */) => Effect.Effect<{ok: boolean}, never, never>;
  readonly unregister: (input: /* … */) => Effect.Effect<{ok: true}, never, never>;
  readonly publish: (input: /* … */) => Effect.Effect<{delivered: number}, never, never>;
}

// (2) Class Tag — identity + contract, no body. Importing this pulls in no DO
// runtime (the bundler tree-shakes `.make()` out of consumers).
export class LiveDO extends Cloudflare.DurableObjectNamespace<LiveDO, LiveRpcSurface>()("LiveDO") {}

// (3) Implementation Layer.
export const LiveDOLive = LiveDO.make(
  Effect.gen(function* () {
    // ── SHARED INIT (once per namespace) ──
    // Resolve the DO's OWN namespace here for cross-role addressing. Use the
    // `.from(scriptName)` overload — NOT a bare `yield* LiveDO`. `.from("phoenix")`
    // binds by host script name → `Effect<…, never, Worker>`, so the Layer stays
    // `Layer<LiveDO, never, Worker>`. A bare `yield* LiveDO` would leak `LiveDO`
    // as an unsatisfiable self-requirement (the very Tag this Layer outputs).
    // The string must stay in sync with `Phoenix.make("phoenix", …)` in index.ts.
    const live = yield* LiveDO.from("phoenix");

    // The shared-init gen RETURNS the per-instance Effect (run once per instance
    // wake). `return yield*` would collapse the two phases — see below.
    // @effect-diagnostics-next-line effect/returnEffectInGen:off
    return Effect.gen(function* () {
      // ── PER-INSTANCE (once per instance wake) ──
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

The outer `Effect.gen` runs once per namespace (resolve the self-namespace,
shared setup). The inner `Effect.gen` runs per instance wake and closes over
per-instance state — this closure is alchemy's equivalent of instance fields and
persists for the instance's lifetime. `return Effect.gen(...)` returns the inner
Effect **unrun** so alchemy invokes it per instance; `return yield* Effect.gen(...)`
would run per-instance setup during shared init (wrong lifecycle). The
`effect/returnEffectInGen:off` suppression is correct here — annotate with **why**.

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
yield* live.getByName(`topic:${topicKey}`).publish({topicKey, frame, limits});
yield* live.getByName(`connection:${id}`).deliver({frame, row, limits});
```

Reserve `fetch` for the genuinely request-shaped interaction — the SSE upgrade.
Everything else (`subscribe`, `register`, `publish`, `check`, …) is a method.

## Addressing: `getByName` only

The alchemy DO stub exposes **only `getByName(name)` and `fetch(HttpServerRequest)`**.
`idFromName`, `idFromString`, `get`, `newUniqueId`, and `jurisdiction` are
unavailable on the alchemy stub. All addressing is name-based — and for `LiveDO`
the name *is* the role + key:

```ts
const topic = live.getByName(`topic:${topicKey}`);
const connection = live.getByName(`connection:${connectionId}`);
```

The `generation` stale model holds under name addressing: the only handle is the
human-readable `connection:${id}` key, so the topic registry stores and re-derives
that key, and `generation`+`revision` carry the staleness no opaque id is needed.

## KV storage (no SQLite)

Storage is `state.storage`'s KV API, mirroring void's flat keys — there is no SQL
table and no `@effect/sql-sqlite-do`:

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
> `deserializeAttachment`, `state.getWebSockets()`, and the `webSocketMessage` /
> `webSocketClose` handler slots — see the alchemy `Room` example. phoenix
> doesn't need them today.

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
      const result = yield* live.getByName(`connection:${connectionId}`)
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
resolved `DurableObjectState` + the self-namespace as plain args, so a
node-pool unit test drives it without workerd (inject a fake state + a fake
namespace whose `getByName` returns stubs). See
`features/fate-live/do.test.ts` for the unit driver and
`tests/integration/fate-live.test.ts` for the black-box-over-HTTP version.

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — `yield* SomeDO` and the
  `.from(scriptName)` self/cross-script binding overload
- [alchemy-http-router.md](./alchemy-http-router.md) — the `/fate/live` route
  that forwards to a `connection:` instance
- [fate-live-views.md](./fate-live-views.md) — the live protocol and the DO in
  the wider live picture
- [effect-sse-externally-driven.md](./effect-sse-externally-driven.md) — the
  held-stream queue + keep-alive shape
- [ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md) — why one
  unified `LiveDO` (supersedes the 0025 split, retires the 0033 mutual-DO rule)
