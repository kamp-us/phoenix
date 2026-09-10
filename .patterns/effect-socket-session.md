# Serving one Effect `Socket` session

How a per-connection handler over `effect/unstable/socket` is shaped, and the one ordering rule that
is not optional. Grounded in the module source at apps/tuval's pin (`effect@4.0.0-rc.112`,
`src/unstable/socket/Socket.ts`) and demonstrated by
[`apps/tuval/src/shell/transport/server.ts`](../apps/tuval/src/shell/transport/server.ts) +
[`client.ts`](../apps/tuval/src/shell/transport/client.ts).

## The rule: nothing writes before the run starts

A `Socket`'s two halves are asymmetric. `socket.writer` hands you a `write` immediately, but
`fromWebSocket` builds that `write` as `latch.whenOpen(…)` over a latch **the run loop itself
opens** — `runRaw` sets `currentWS` and calls `latch.openUnsafe()` after the socket is open, and
closes the latch again on exit. So a `write` issued before `socket.run`/`runString` does not fail
and does not drop: it *blocks*. A handler that greets its client and then starts reading —

```ts
const write = yield* socket.writer;
yield* write(snapshot);            // blocks: the latch is still closed
yield* socket.runString(onText);   // never reached
```

— deadlocks the connection with no error anywhere. The client sees an open socket and silence.

Put every startup write in the run's `onOpen` instead, which the same source runs after the latch
opens:

```ts
const greet = Effect.gen(function* () {
  yield* Effect.forkIn(Stream.runForEach(changes, send), scope);
  for (const row of yield* snapshot) yield* send(row);
  yield* Effect.ignore(Deferred.succeed(ready, undefined));
});

yield* socket.runString((text) => Deferred.await(ready).pipe(Effect.andThen(handle(text))), {
  onOpen: greet,
});
```

## Why the `ready` latch is there too

`onOpen` is awaited on the run fiber, but incoming messages are dispatched into a `FiberSet` and run
concurrently — a frame can be handled while `greet` is still forking its subscriptions. Gating the
message handler on a `Deferred` filled at the end of `greet` is what keeps a subscription the frame
depends on from being started after the frame that needed it.

## The rest of the shape

- **Long-lived subscriptions fork into the session's own Scope** (`Effect.forkIn(…, scope)` under an
  `Effect.scoped` handler), so the connection closing stops them. `SocketServer.run` closes each
  handler's fibers with its own scope.
- **A write races the socket's close.** Losing that race is the close, not the fiber's failure, so
  per-frame sends are `Effect.ignore(write(…))` and the run loop's exit is the one place a socket
  error is read.
- **Refuse the upgrade, not the first frame.** `NodeSocketServer.makeWebSocket` takes `ws`'s server
  options, so an auth or origin fence belongs in `verifyClient`: a `false` answers 401 and no
  `connection` event fires, which is the only way to refuse before a frame exists.
- **Closing on a bad frame is a `CloseEvent` through the same writer** —
  `write(new Socket.CloseEvent(1008, reason))` — never a bare `ws.close`.

## Expected page closes finish the session

The server applies one named `quietPageClose` policy to the run loop: 1000 (normal), 1001
(going away), and 1006 (observed abnormal closure without a close frame). These meanings come from
[RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1); treating those page
disconnections as successful session completion is Tuval's policy, not a protocol requirement.
1006 is observed locally, never sent in a close frame. Other codes, including policy violation
1008, remain failures.

At `effect@4.0.0-rc.112`, `SocketCloseError.filterClean` checks both the outer `SocketError`
and inner close reason before applying its code predicate. Unmatched values return unchanged.
Pair it with `Effect.catchFilter` on `runString`, as the pinned `Socket.fromWebSocket`
implementation does internally. Read, write, and open failures escaping the run loop retain their
identity. The existing per-frame write-race policy above is separate.

At `@effect/platform-node-shared@4.0.0-rc.112`, `src/NodeSocketServer.ts` constructs accepted
sockets without a close-code override and reports the handler's failure cause. The socket default
considers every close code an error, so the session must apply its own narrow policy before that
reporter. Session scope finalization still removes its page sender and stops its subscriptions;
it does not terminate attached kernel processes. The session unit tests prove cleanup and process
survival, and the real WebSocket regression terminates a page without a handshake, captures the
server reporter, and reattaches to the retained process.
