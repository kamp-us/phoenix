# Durable Objects

How phoenix's live fan-out DOs are written on alchemy. The short answer: `Cloudflare.DurableObjectNamespace<Self>()(name, body)`, where `body` is a two-phase Effect — shared init, then a per-instance Effect that yields `Cloudflare.DurableObjectState` and returns handlers. Methods you return become **typed RPC** the worker (and other DOs) call through a stub; `fetch` handles request-shaped interactions like the SSE upgrade. SQLite, KV storage, alarms, and WebSocket hibernation are all Effect-wrapped.

This replaces the plain `class extends DurableObject` form. phoenix has two DOs — `ConnectionDO` (holds one client's SSE stream) and `TopicDO` (the durable subscriber registry + fan-out), split per ADR 0023/0025.

## The shape

```ts
// worker/fate/topic-do.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import ConnectionDO from "./connection-do";

export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()(
  "TopicDO",
  Effect.gen(function* () {
    // ── SHARED INIT (once per namespace) ──
    // Bind sibling resources the DO needs. Resolving ConnectionDO here is how
    // the topic→connection fan-out direction is wired — and the only direction
    // available, so a topic→topic call stays unrepresentable (ADR 0025).
    const connections = yield* ConnectionDO;

    return Effect.gen(function* () {
      // ── PER-INSTANCE (once per instance wake) ──
      const state = yield* Cloudflare.DurableObjectState;
      yield* state.storage.sql.exec(CREATE_SUBSCRIBERS_TABLE);

      return {
        // typed RPC methods (below)
        register: (sub: SubscribeControl) => /* … */,
        deregister: (sub: {connectionId: string; subId: string}) => /* … */,
        publish: (msg: PublishMessage) => /* … */,
        // alarm handler
        alarm: () => /* reap orphaned subscribers */,
      };
    });
  }),
) {}
```

The outer `Effect.gen` runs once per namespace (bind siblings, shared setup). The inner `Effect.gen` runs per instance wake and closes over per-instance state — this closure is the alchemy equivalent of instance fields, and it persists for the instance's lifetime exactly like fields do on a plain DO class.

## RPC methods instead of fetch-path dispatch

Today the DOs dispatch on `url.pathname` inside `fetch` (`/subscribe`, `/publish`, `/probe`, …). On alchemy, return **named methods** instead — each becomes a typed RPC on the stub. This deletes the manual routing and the request/response (de)serialization:

```ts
// caller (in the worker, or in another DO's init scope)
const topics = yield* TopicDO;
const topic = topics.getByName(`topic:${topicKey}`);
yield* topic.publish(message);          // typed; no fetch, no JSON.parse
```

Reserve `fetch` for genuinely request-shaped interactions — the SSE upgrade on `ConnectionDO`. Everything else (`register`, `deregister`, `publish`, `probe`) is a method.

## Per-instance state & storage

`Cloudflare.DurableObjectState` exposes Effect-wrapped storage:

- **`state.storage.get/put/delete`** — the transactional KV store. `ConnectionDO`'s persisted `generation` lives here: `yield* state.storage.put("generation", n)`.
- **`state.storage.sql.exec<Row>(query, ...bindings)`** — the embedded SQLite. Returns a `SqlCursor<Row>` that is both a `Stream` and has `.toArray()`, `.one()`, `.next()`. `TopicDO`'s `subscribers` table ports directly:

  ```ts
  const rows = yield* state.storage.sql
    .exec<SubscriberRow>("SELECT * FROM subscribers")
    .pipe(Effect.flatMap((c) => c.toArray()));
  ```
- **`state.storage.setAlarm/getAlarm/deleteAlarm`** — alarms. `TopicDO`'s 60s reap schedules with `yield* state.storage.setAlarm(Date.now() + 60_000)` and implements the `alarm: () => Effect` handler.

> **`SqlStorageValue` constraint.** `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`. Keep the row interface's index signature (`[column: string]: string | number`) exactly as `TopicDO` has it today, or the generic won't satisfy.

## ConnectionDO: holding the SSE stream

`ConnectionDO` keeps one client's open SSE stream. The controller, heartbeat, owner, and subscription map live in the per-instance closure (where instance fields lived before); `fetch` opens the stream and returns it via `HttpServerResponse.fromWeb`:

```ts
export default class ConnectionDO extends Cloudflare.DurableObjectNamespace<ConnectionDO>()(
  "ConnectionDO",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const encoder = new TextEncoder();

      // per-instance, closure-held (was: instance fields)
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const subscriptions = new Map<string, {topics: ReadonlyArray<string>}>();

      const openStream = (ownerId: string) =>
        Effect.gen(function* () {
          const next = ((yield* state.storage.get<number>("generation")) ?? 0) + 1;
          yield* state.storage.put("generation", next);
          const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
              controller = c;
              c.enqueue(encoder.encode(": connected\n\n"));
              heartbeat = setInterval(() => controller?.enqueue(encoder.encode(": heartbeat\n\n")), 25_000);
            },
            cancel: () => { if (heartbeat) clearInterval(heartbeat); controller = undefined; },
          });
          return HttpServerResponse.fromWeb(new Response(stream, {headers: SSE_HEADERS}));
        });

      return {
        // SSE upgrade stays a fetch (request-shaped)
        fetch: Effect.gen(function* () {
          const raw = yield* Cloudflare.Request;
          const ownerId = new URL(raw.url).searchParams.get("ownerId")!;
          return yield* openStream(ownerId);
        }),
        // delivery is a typed RPC the topic DO calls
        deliver: (frame: DeliverFrame) =>
          Effect.sync(() => controller?.enqueue(encoder.encode(encodeFrame(frame)))),
        subscribe: (control: SubscribeControl) => /* register with TopicDO stubs */,
        unsubscribe: (subId: string) => /* deregister */,
        probe: () => state.storage.get<number>("generation"),
      };
    });
  }),
) {}
```

`setInterval` works unchanged inside the handler — the stream pins the DO in memory (no hibernation), exactly as today. The delivery path stays a trivial `Effect.sync(controller.enqueue)`, so the latency-sensitive write costs nothing extra for being in Effect.

> **No WebSocket hibernation here.** `ConnectionDO` holds an HTTP SSE stream, not a WebSocket, so the hibernation API doesn't apply. For DOs that *do* use WebSockets, alchemy provides `Cloudflare.upgrade()` (returns `[response, socket]`), `socket.serializeAttachment`/`deserializeAttachment`, `state.getWebSockets()`, and the `webSocketMessage`/`webSocketClose` handler slots — see the alchemy `Room` example. phoenix doesn't need them today.

## Cross-DO calls preserve direction

The fan-out invariant (ADR 0025) survives the port and gets *stronger*: `TopicDO` resolves `ConnectionDO` in its init and calls `connection.deliver(frame)` / `connection.probe()` as typed RPC; `ConnectionDO` resolves `TopicDO` and calls `topic.register(...)`. Neither namespace can resolve its own kind, so topic→topic and connection→connection calls don't type-check. The binding *is* the direction.

## Alarms

The reap alarm is the `alarm` handler plus `setAlarm`:

```ts
return {
  register: (sub) =>
    Effect.gen(function* () {
      yield* state.storage.sql.exec("INSERT OR REPLACE INTO subscribers …", /* … */);
      yield* state.storage.setAlarm(Date.now() + 60_000);  // ensure the reaper runs
    }),
  alarm: () =>
    Effect.gen(function* () {
      const rows = yield* state.storage.sql.exec<SubscriberRow>("SELECT * FROM subscribers")
        .pipe(Effect.flatMap((c) => c.toArray()));
      yield* Effect.forEach(rows, probeAndReap, {concurrency: "unbounded"});
      if (/* rows remain */) yield* state.storage.setAlarm(Date.now() + 60_000);
    }),
};
```

The miss-count / generation logic inside `probeAndReap` is the existing `TopicDO` algorithm verbatim — only the storage and fetch calls become `yield*`. Keep the per-probe timeout (`Effect.timeout`) so one unreachable connection can't stall the single-threaded DO.

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — `yield* SomeDO` and cross-DO binding
- [alchemy-http-router.md](./alchemy-http-router.md) — the `/fate/live` route that forwards to `ConnectionDO`
- [fate-live-views.md](./fate-live-views.md) — the live protocol, `liveBus`, and the connection/topic split these DOs implement
- [ADR 0025](../.decisions/0025-split-livedo-connection-topic.md) — why connection and topic are separate DOs
