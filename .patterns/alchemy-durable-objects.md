# Durable Objects

How phoenix's live fan-out DOs are written on alchemy. The short answer: `export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()("TopicDO", body) {}`, where `body` is a two-phase Effect — shared init, then a per-instance Effect that yields `Cloudflare.DurableObjectState` and returns handlers. Methods you return become **typed RPC** the worker (and other DOs) call through a stub; `fetch` handles request-shaped interactions like the SSE upgrade. SQLite, KV storage, alarms, and WebSocket hibernation are all Effect-wrapped.

This is the form in place of a plain `class extends DurableObject`. phoenix has two DOs — `ConnectionDO` (holds one client's SSE stream) and `TopicDO` (the durable subscriber registry + fan-out), split per ADR 0023/0025. They live in `worker/features/fate-live/connection-do.ts` and `worker/features/fate-live/topic-do.ts`.

> **Both DOs use the inline form — the modular `.make()` form is not implemented for DOs.** alchemy's `DurableObjectNamespace.ts` JSDoc documents a modular `class Foo extends …()("Foo") {}` + `export default Foo.make(impl)` form (for tree-shaking when DOs reference each other), but in `alchemy@2.0.0-beta.44` it **does not exist**: `()("Name")` with no impl returns a plain object (no `.make`), and `class X extends …()("Name") {}` throws *"superclass is not a constructor"*. Only `Worker` got `.make`; DOs didn't. So both DOs use the **inline** form — `export default class X extends …DurableObjectNamespace<X>()("Name", Effect.gen(…)) {}`. The mutual ES imports between the two DO files are fine; circular *imports* aren't the problem (see the next note for what is).

> **Bidirectional binding: resolve the sibling DO lazily (in the method, never in init).** `ConnectionDO`↔`TopicDO` cross-call in both directions. The hard constraint: a `yield* OtherDO` in the **init** block of *both* DOs (an eager circular binding) **deterministically OOMs the build** (heap climbs to ~4 GB, fatal). The working pattern is **symmetric-lazy**: resolve the sibling **inside the RPC method body**, per call — `publish: () => Effect.gen(function*(){ const connections = yield* ConnectionDO; … })`. With that, both legs work: subscribe→publish→the frame arrives on the held SSE stream. This carries typed RPC, `state.storage.sql.exec`, held-stream fan-out (`controller.enqueue` into a stream held in one DO from another DO's RPC), and the bidirectional cross-resolution — **never resolve the sibling DO in init**.

## The shape

```ts
// worker/features/fate-live/topic-do.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import ConnectionDO from "./connection-do";

export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()(
  "TopicDO",
  Effect.gen(function* () {
    // ── SHARED INIT (once per namespace) ──
    // Do NOT resolve the sibling DO here. `yield* ConnectionDO` in init — paired
    // with `yield* TopicDO` in ConnectionDO's init — is an eager circular binding
    // that OOMs the build (verified). Resolve the sibling lazily, in the method.
    return Effect.gen(function* () {
      // ── PER-INSTANCE (once per instance wake) ──
      const state = yield* Cloudflare.DurableObjectState;
      yield* state.storage.sql.exec(CREATE_SUBSCRIBERS_TABLE);

      return {
        register: (sub: SubscribeControl) => /* upsert subscriber row */,
        deregister: (sub: {connectionId: string; subId: string}) => /* … */,
        publish: (msg: PublishMessage) =>
          Effect.gen(function* () {
            const connections = yield* ConnectionDO; // lazy — per call, never in init
            // …read subscriber rows, then for each:
            // yield* connections.getByName(`connection:${id}`).deliver(frame)
          }),
        alarm: () => /* reap orphaned subscribers */,
      };
    });
  }),
) {}
```

The outer `Effect.gen` runs once per namespace (bind siblings, shared setup). The inner `Effect.gen` runs per instance wake and closes over per-instance state — this closure is the alchemy equivalent of instance fields, and it persists for the instance's lifetime exactly like fields do on a plain DO class.

## RPC methods instead of fetch-path dispatch

Rather than dispatching on `url.pathname` inside `fetch` (`/subscribe`, `/publish`, `/probe`, …), the DOs return **named methods** — each becomes a typed RPC on the stub. There is no manual routing or request/response (de)serialization:

```ts
// caller (in the worker, or in another DO's init scope)
const topics = yield* TopicDO;
const topic = topics.getByName(`topic:${topicKey}`);
yield* topic.publish(message);          // typed; no fetch, no JSON.parse
```

Reserve `fetch` for genuinely request-shaped interactions — the SSE upgrade on `ConnectionDO`. Everything else (`register`, `deregister`, `publish`, `probe`) is a method.

## Addressing: `getByName` only

The alchemy DO stub exposes **only `getByName(name)` and `fetch(HttpServerRequest)`**. `idFromName`, `idFromString`, `get`, `newUniqueId`, and `jurisdiction` are commented out / unavailable — none exist on the alchemy stub. (The old wrangler code addressed DOs by id — `env.CONNECTION_DO.get(idFromName("connection:" + id))`, `env.TOPIC_DO.get(idFromName("topic:" + key))`, and `idFromString(connectionId)` inside `TopicDO`.) All addressing is name-based:

```ts
const connection = connections.getByName(`connection:${connectionId}`);
const topic = topics.getByName(`topic:${topicKey}`);
```

> **The `generation` invariant holds under name addressing.** `ConnectionDO`'s reconnect/stale-detection turns on a persisted `generation` counter. The old code resolved a connection via `idFromString(connectionId)` — an *opaque* id; under name addressing the only handle is the human-readable `connection:${id}` key, so the registry stores and re-derives that key, and the generation-based stale-detection invariant holds across it (no opaque-id path remains to lean on).

## The live publish path

The live publish path is a redesign of `live.ts` / `live-route.ts`, not a mechanical port of the old code.

The old `liveBus` reached `TopicDO` outside any Effect/handler scope: a synchronous publish call resolved the binding off `env`, built a request, and forwarded through `waitUntil`. The plumbing was an `AsyncLocalStorage<{env, waitUntil}>` (`livePublishContext`) set up per request so the synchronous `live.*` methods could reach the runtime:

```ts
// old wrangler code — live.ts
const topic = env.TOPIC_DO.get(env.TOPIC_DO.idFromName(`topic:${topicKey}`));
waitUntil(topic.fetch("https://live/publish", {method: "POST", body: JSON.stringify(msg)}));
```

Two things don't exist on alchemy: `idFromName`, and `stub.fetch(urlString, init)` (the stub's `fetch` takes an `HttpServerRequest`). So the path is:

- The `TopicDO` namespace is **resolved in worker init** (`const topics = yield* TopicDO`), not pulled off `env` per call.
- The publish is a **typed RPC**: `topics.getByName(`topic:${topicKey}`).publish(message)` — no URL, no `JSON.stringify`.
- The fan-out is fired-and-forgotten, with `waitUntil` from `yield* Cloudflare.WorkerExecutionContext` rather than an `AsyncLocalStorage`-carried closure.

`livePublishContext` and the `https://live/publish` string-URL `fetch` are gone; the binding and `waitUntil` come from the alchemy runtime in scope.

## Per-instance state & storage

`Cloudflare.DurableObjectState` exposes Effect-wrapped storage:

- **`state.storage.get/put/delete`** — the transactional KV store. `ConnectionDO`'s persisted `generation` lives here: `yield* state.storage.put("generation", n)`.
- **`state.storage.sql.exec<Row>(query, ...bindings)`** — the embedded SQLite. Returns a `SqlCursor<Row>` that is both a `Stream` and has `.toArray()`, `.one()`, `.next()`. `TopicDO`'s `subscribers` table lives here:

  ```ts
  const rows = yield* state.storage.sql
    .exec<SubscriberRow>("SELECT * FROM subscribers")
    .pipe(Effect.flatMap((c) => c.toArray()));
  ```
- **`state.storage.setAlarm/getAlarm/deleteAlarm`** — alarms. `TopicDO`'s 60s reap schedules with `yield* state.storage.setAlarm(Date.now() + 60_000)` and implements the `alarm: () => Effect` handler.

> **`SqlStorageValue` constraint.** `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`. The row interface keeps an index signature (`[column: string]: string | number`), as `TopicDO`'s does, or the generic won't satisfy.

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
        subscribe: (control: SubscribeControl) =>
          Effect.gen(function* () {
            const topics = yield* TopicDO; // lazy — per call, never in init (else OOM)
            // yield* topics.getByName(`topic:${key}`).register(...)
          }),
        unsubscribe: (subId: string) => /* deregister from TopicDO (lazy resolve) */,
        probe: () => state.storage.get<number>("generation"),
      };
    });
  }),
) {}
```

`setInterval` works unchanged inside the handler — the stream pins the DO in memory (no hibernation). The delivery path is a trivial `Effect.sync(controller.enqueue)`, so the latency-sensitive write costs nothing extra for being in Effect.

> **No WebSocket hibernation here.** `ConnectionDO` holds an HTTP SSE stream, not a WebSocket, so the hibernation API doesn't apply. For DOs that *do* use WebSockets, alchemy provides `Cloudflare.upgrade()` (returns `[response, socket]`), `socket.serializeAttachment`/`deserializeAttachment`, `state.getWebSockets()`, and the `webSocketMessage`/`webSocketClose` handler slots — see the alchemy `Room` example. phoenix doesn't need them today.

## Cross-DO calls preserve direction

The fan-out invariant (ADR 0025) is enforced by the type system: `TopicDO` resolves `ConnectionDO` (lazily, inside `publish`/`probe`) and calls `connection.deliver(frame)` / `connection.probe()` as typed RPC; `ConnectionDO` resolves `TopicDO` (lazily, inside `subscribe`/`unsubscribe`) and calls `topic.register(...)`. Neither namespace can resolve its own kind, so topic→topic and connection→connection calls don't type-check. The binding *is* the direction.

This is a **circular DO↔DO binding** — each DO resolves the other. It works in both directions **only because the resolution is lazy**: `yield* OtherDO` happens per call inside the method, never in the init block. An eager `yield* OtherDO` in both inits OOMs the build — see the binding note at the top.

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

The miss-count / generation logic inside `probeAndReap` is the same algorithm `TopicDO` has always used — the storage and fetch calls are `yield*`. The per-probe timeout (`Effect.timeout`) keeps one unreachable connection from stalling the single-threaded DO.

## See also

- [alchemy-bindings.md](./alchemy-bindings.md) — `yield* SomeDO` and cross-DO binding
- [alchemy-http-router.md](./alchemy-http-router.md) — the `/fate/live` route that forwards to `ConnectionDO`
- [fate-live-views.md](./fate-live-views.md) — the live protocol, `liveBus`, and the connection/topic split these DOs implement
- [ADR 0025](../.decisions/0025-split-livedo-connection-topic.md) — why connection and topic are separate DOs
