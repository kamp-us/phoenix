# Externally-driven SSE — `Stream.fromQueue` + `HttpServerResponse.stream`

How phoenix builds an SSE response stream that's pushed from outside the
response Effect — the case where frames arrive via a sibling DO's RPC
(`ConnectionDO.deliver(...)`) rather than being produced inline by the
stream's own generator. This is the canonical shape for "long-lived
response, written to by another component".

`ConnectionDO` is the only consumer today (`apps/web/worker/features/fate-live/connection-do.ts and topic-do.ts`
`openStream`/`deliver`), and the algorithm matters: the legacy code did
this with a raw `ReadableStream` controller, a `setInterval` for heartbeats,
and a try/catch around `controller.enqueue`. That worked but spread the
state across three independent imperative subsystems. The effect
composition collapses them into one stream pipeline with linear data flow
and automatic finalization.

## The shape

Four pieces, composed:

```ts
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const encoder = new TextEncoder();
const CONNECTED_FRAME = encoder.encode(": connected\n\n");
const HEARTBEAT_FRAME = encoder.encode(": heartbeat\n\n");

let framesQueue: Queue.Queue<Uint8Array> | undefined;

const closeStream = Effect.gen(function* () {
  const q = framesQueue;
  if (q !== undefined) {
    framesQueue = undefined;
    // Idempotent. Completes the Dequeue side, which terminates
    // `Stream.fromQueue`. The merged heartbeat fiber tears down via the
    // merged-stream finalizer (no separate interval to clear).
    yield* Queue.shutdown(q);
  }
});

const openStream = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Uint8Array>();
  framesQueue = queue;

  // Initial SSE preamble — offered before the stream is wired to the
  // response so the first frame the client reads is `: connected\n\n`.
  yield* Queue.offer(queue, CONNECTED_FRAME);

  // 25-second heartbeat. `Stream.tick` emits `void` immediately and then
  // on every interval; `drop(1)` skips the immediate tick so the first
  // heartbeat lands at +25s (matching a `setInterval(25_000)`).
  const heartbeats = Stream.tick("25 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => HEARTBEAT_FRAME),
  );

  const frames = Stream.fromQueue(queue);
  const merged = Stream.merge(frames, heartbeats).pipe(Stream.ensuring(closeStream));

  return HttpServerResponse.stream(merged, {headers: SSE_HEADERS});
});

// The deliver path — called from another component (a sibling DO's RPC).
const deliver = (frame: Uint8Array) =>
  Effect.gen(function* () {
    const queue = framesQueue;
    if (queue === undefined) return {delivered: false};
    // `Queue.offer` is total — `false` if the queue has been shut down
    // (the stream was finalized by client disconnect) rather than thrown,
    // so no try/catch is needed.
    const accepted = yield* Queue.offer(queue, frame);
    return {delivered: accepted};
  });
```

## The four pieces

- **The Queue** is the producer/consumer seam. `Queue.unbounded<Uint8Array>()`
  is the shared buffer; the response holds the Dequeue side via
  `Stream.fromQueue`, and external pushers hold the Enqueue side via
  `Queue.offer`. The closure captures the queue reference so the deliver
  path can reach it after `openStream` has returned.
- **The frames Stream** — `Stream.fromQueue(queue)`. This is the response
  body's data source. It pulls one element per `Queue.offer`; it
  terminates when `Queue.shutdown` is called.
- **The heartbeat Stream** — `Stream.tick("25 seconds")` + `Stream.drop(1)`
  + `Stream.map(() => HEARTBEAT_FRAME)`. Merged into the frames stream as
  a sibling so the heartbeat lives and dies with the response.
- **The response** — `HttpServerResponse.stream(merged, {headers: SSE_HEADERS})`
  takes the merged stream as the body. The underlying HTTP runtime pulls
  from the stream; when the reader cancels (client disconnect), the
  `Stream.ensuring(closeStream)` finalizer fires.

## Why not the raw `ReadableStream` controller approach

The legacy version did this with three independent imperative subsystems:

```ts
// Legacy — three subsystems, manually coordinated.
let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const stream = new ReadableStream({
  start: (c) => {
    controller = c;
    c.enqueue(encoder.encode(": connected\n\n"));
    heartbeat = setInterval(() => controller?.enqueue(encoder.encode(": heartbeat\n\n")), 25_000);
  },
  cancel: () => {
    if (heartbeat) clearInterval(heartbeat);
    controller = undefined;
  },
});
const deliver = (frame: Uint8Array) => {
  try {
    controller?.enqueue(frame);  // throws if stream closed
  } catch { /* swallow */ }
};
```

Three problems the effect composition removes:

- **The deliver path needs a try/catch** because `controller.enqueue`
  throws if the stream has been canceled. `Queue.offer` is total — it
  returns `false` when the queue is shut down, so the handler can branch
  on the boolean (and report `delivered: false` to the caller, which is
  the signal the topic DO uses to prune an orphaned subscriber row).
- **The heartbeat is a sibling subsystem** (`setInterval` outside the
  stream), so cleanup is a separate `clearInterval` in `cancel`. As a
  merged `Stream.tick`, the heartbeat is part of the same stream pipeline
  and is finalized by the same `Stream.ensuring` clause.
- **The controller reference outlives the stream.** A late `deliver` after
  cancel could throw past the try/catch in some edge orderings. With the
  queue + shutdown, the shutdown is idempotent and total — `Queue.offer`
  can be called any number of times after shutdown without throwing.

The effect form is one pipeline with linear data flow and one finalizer
clause. The legacy form is three things glued together; this is one.

## Cleanup

`Stream.ensuring(closeStream)` is the response body's cleanup hook. It
runs when:

- The HTTP runtime cancels the underlying reader (client disconnect, TCP
  close, a forced close from the worker).
- The stream terminates from the inside (the queue is shut down by a
  reconnect on the same connection name — `openStream` calls
  `yield* closeStream` before opening a new queue).

`Queue.shutdown` is idempotent, so the cleanup is safe to call from
multiple paths (the merged-stream finalizer and the reconnect path both
hit it). The heartbeat fiber doesn't need explicit teardown — it's part
of the merged stream, so the stream's own finalizer tears it down.

## A note on `Stream.repeatEffect`

`effect@4.0.0-beta.74` does **not** export `Stream.repeatEffect`. The
heartbeat uses `Stream.tick("25 seconds").pipe(Stream.drop(1), Stream.map(...))`
instead. The `drop(1)` is necessary because `Stream.tick` emits
immediately on subscribe and then on every interval — without the drop,
the first "heartbeat" arrives at t=0, before the `: connected` preamble
has been read by the client. With the drop, the first heartbeat lands at
t=25s, matching the legacy `setInterval` cadence.

## The deliver call site

The deliver path is called from another component — in phoenix's case, the
unified `LiveDO`'s topic role invokes the connection role's `deliver({frame,
row, limits})` across its OWN namespace (`live.getByName(\`connection:${id}\`)`,
resolved once in init). The deliver handler offers the encoded frame onto the
queue; the response body's stream wakes up; the client reads the frame off the
SSE connection. The deliver Effect's `R` is `never` — no Layer wiring, no
runtime; just a queue offer.

## Citations

- `apps/web/worker/features/fate-live/live-do.ts` — `openStream`, `deliver`,
  `closeStream` on the unified `LiveDO` (the production pattern, after the
  refactor from the raw `ReadableStream` controller form). The connection role
  owns `openStream` per instance; the `fetch` handler routes the SSE upgrade to
  `instance.openStream`.

## See also

- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the unified
  `LiveDO` (RPC + `fetch`, KV `state.storage`, the topic role's `deliver` →
  connection role seam that drives this deliver path).
- [fate-live-views.md](./fate-live-views.md) — the live protocol the SSE
  stream carries.
- [ADR 0034](../.decisions/0034-fate-native-sse-protocol.md) — why
  phoenix stays on SSE rather than WebSocket.
