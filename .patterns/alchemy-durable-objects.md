# Durable Objects

How phoenix's live fan-out DOs are written on alchemy. The short answer: `export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()("TopicDO", body) {}`, where `body` is a two-phase Effect — shared init, then a per-instance Effect that yields `Cloudflare.DurableObjectState` and returns handlers. Methods you return become **typed RPC** the worker (and other DOs) call through a stub; `fetch` handles request-shaped interactions like the SSE upgrade. SQLite, KV storage, alarms, and WebSocket hibernation are all Effect-wrapped.

This replaces the plain `class extends DurableObject` form. phoenix has two DOs — `ConnectionDO` (holds one client's SSE stream) and `TopicDO` (the durable subscriber registry + fan-out), split per ADR 0023/0025.

> **Use the inline form — the modular `.make()` form is not implemented for DOs.** alchemy's `DurableObjectNamespace.ts` JSDoc documents a modular `class Foo extends …()("Foo") {}` + `export default Foo.make(impl)` form (for tree-shaking when DOs reference each other), but in `alchemy@2.0.0-beta.44` it **does not exist**: `()("Name")` with no impl returns a plain object (no `.make`), and `class X extends …()("Name") {}` throws *"superclass is not a constructor"*. Only `Worker` got `.make`; DOs didn't. So both DOs use the **inline** form — `export default class X extends …DurableObjectNamespace<X>()("Name", Effect.gen(…)) {}`. The mutual ES imports between the two DO files are fine; circular *imports* aren't the problem (see the next note for what is).

> **Bidirectional binding: SPIKED — works, but resolve the sibling DO lazily (in the method, never in init).** Under `alchemy dev` (alchemy `2.0.0-beta.44`, effect `4.0.0-beta.70`) a POC confirmed `ConnectionDO`↔`TopicDO` cross-calls both directions. The hard constraint: a `yield* OtherDO` in the **init** block of *both* DOs (an eager circular binding) **deterministically OOMs the build** (heap climbs to ~4 GB, fatal). The working pattern is **symmetric-lazy**: resolve the sibling **inside the RPC method body**, per call — `publish: () => Effect.gen(function*(){ const connections = yield* ConnectionDO; … })`. With that, both legs work: subscribe→publish→the frame arrived on the held SSE stream. Verified facts: typed RPC, `state.storage.sql.exec`, held-stream fan-out (`controller.enqueue` into a stream held in one DO from another DO's RPC), and the bidirectional cross-resolution. So the ADR 0023/0025 port is viable — **never resolve the sibling DO in init**.

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

Today the DOs dispatch on `url.pathname` inside `fetch` (`/subscribe`, `/publish`, `/probe`, …). On alchemy, return **named methods** instead — each becomes a typed RPC on the stub. This deletes the manual routing and the request/response (de)serialization:

```ts
// caller (in the worker, or in another DO's init scope)
const topics = yield* TopicDO;
const topic = topics.getByName(`topic:${topicKey}`);
yield* topic.publish(message);          // typed; no fetch, no JSON.parse
```

Reserve `fetch` for genuinely request-shaped interactions — the SSE upgrade on `ConnectionDO`. Everything else (`register`, `deregister`, `publish`, `probe`) is a method.

## Addressing: `getByName` only

The alchemy DO stub exposes **only `getByName(name)` and `fetch(HttpServerRequest)`**. `idFromName`, `idFromString`, `get`, `newUniqueId`, and `jurisdiction` are commented out / unavailable. phoenix today addresses DOs by id — `env.CONNECTION_DO.get(idFromName("connection:" + id))` in `live-route.ts`, `env.TOPIC_DO.get(idFromName("topic:" + key))` in `live.ts`, and even `idFromString(connectionId)` inside `TopicDO`. **None of those exist on the alchemy stub.** All addressing becomes name-based:

```ts
const connection = connections.getByName(`connection:${connectionId}`);
const topic = topics.getByName(`topic:${topicKey}`);
```

> **Re-confirm the `generation` invariant under name addressing.** `ConnectionDO`'s reconnect/stale-detection turns on a persisted `generation` counter, and `TopicDO` resolves a connection it learned about via `idFromString(connectionId)` — an *opaque* id. Under name addressing the only handle is the human-readable `connection:${id}` key, so the registry must store and re-derive that key, and the generation-based stale-detection invariant must be **re-confirmed** to still hold (no opaque-id path remains to lean on).

## The live publish path

This is a real redesign of `live.ts` / `live-route.ts`, not a mechanical port.

Today `liveBus` (in `live.ts`) reaches `TopicDO` outside any Effect/handler scope: a synchronous publish call resolves the binding off `env`, builds a request, and forwards through `waitUntil`. The plumbing is an `AsyncLocalStorage<{env, waitUntil}>` (`livePublishContext`) set up per request so the synchronous `live.*` methods can reach the runtime:

```ts
// today — live.ts
const topic = env.TOPIC_DO.get(env.TOPIC_DO.idFromName(`topic:${topicKey}`));
waitUntil(topic.fetch("https://live/publish", {method: "POST", body: JSON.stringify(msg)}));
```

Two things break on alchemy: there is no `idFromName`, and `stub.fetch(urlString, init)` does not exist (the stub's `fetch` takes an `HttpServerRequest`). On alchemy the path becomes:

- The `TopicDO` namespace is **resolved in worker init** (`const topics = yield* TopicDO`), not pulled off `env` per call.
- The publish is a **typed RPC**: `topics.getByName(`topic:${topicKey}`).publish(message)` — no URL, no `JSON.stringify`.
- The fan-out is still fired-and-forgotten, but `waitUntil` comes from `yield* Cloudflare.WorkerExecutionContext` rather than an `AsyncLocalStorage`-carried closure.

So `livePublishContext` and the `https://live/publish` string-URL `fetch` both go away; the binding and `waitUntil` are obtained from the alchemy runtime in scope.

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

`setInterval` works unchanged inside the handler — the stream pins the DO in memory (no hibernation), exactly as today. The delivery path stays a trivial `Effect.sync(controller.enqueue)`, so the latency-sensitive write costs nothing extra for being in Effect.

> **No WebSocket hibernation here.** `ConnectionDO` holds an HTTP SSE stream, not a WebSocket, so the hibernation API doesn't apply. For DOs that *do* use WebSockets, alchemy provides `Cloudflare.upgrade()` (returns `[response, socket]`), `socket.serializeAttachment`/`deserializeAttachment`, `state.getWebSockets()`, and the `webSocketMessage`/`webSocketClose` handler slots — see the alchemy `Room` example. phoenix doesn't need them today.

## Cross-DO calls preserve direction

The fan-out invariant (ADR 0025) survives the port and gets *stronger*: `TopicDO` resolves `ConnectionDO` (lazily, inside `publish`/`probe`) and calls `connection.deliver(frame)` / `connection.probe()` as typed RPC; `ConnectionDO` resolves `TopicDO` (lazily, inside `subscribe`/`unsubscribe`) and calls `topic.register(...)`. Neither namespace can resolve its own kind, so topic→topic and connection→connection calls don't type-check. The binding *is* the direction.

This is a **circular DO↔DO binding** — each DO resolves the other. It works (spiked, both directions) **only because the resolution is lazy**: `yield* OtherDO` happens per call inside the method, never in the init block. An eager `yield* OtherDO` in both inits OOMs the build — see the binding note at the top.

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
