# Nothing throws out of a Node event listener

A callback registered with `emitter.on(…)` is called synchronously by the emitter. Nothing above it
holds a `try`, and there is no promise to reject into, so a throw becomes an `uncaughtException` and
the default handler exits the process — Node's `process` docs state that with no
`'uncaughtException'` listener registered, an uncaught exception prints its stack and the process
exits ([Node.js, `process`, `'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception)).
The Effect runtime does not help here: the listener body is plain synchronous JavaScript that Effect
never sees.

So a listener that reads an attacker-controlled value has one rule: **the value's callee must be
total, and the listener catches anyway.** In a local server that rule is a security property, not a
robustness nicety — a single unauthenticated request that reaches a throwing callee is a remote kill
of the whole process, before any credential is checked.

Where this lives today: [`apps/tuval/src/pi/server/`](../apps/tuval/src/pi/server/) —
[`PiServerService.ts`](../apps/tuval/src/pi/server/PiServerService.ts)'s `upgrade` listener over
[`handshake.ts`](../apps/tuval/src/pi/server/handshake.ts), and the same file's `ws.on("message", …)`
over `decodeFrame`.

**It reaches `EventTarget` too, which is where the client side lives.** Node's global `WebSocket` is
an `EventTarget`, not an `EventEmitter`, and a throw out of one of its listeners is the same
`uncaughtException` ([Node.js, `events`, "`EventTarget` error handling"](https://nodejs.org/api/events.html#eventtarget-error-handling));
a probe on Node 26.2.0 confirms it. So the dial side holds the rule as well —
[`apps/tuval/src/pi/client/transport.ts`](../apps/tuval/src/pi/client/transport.ts)'s four
`addEventListener` bodies each compute a verdict and hand it to a handler, and none of them can
throw: the inbound frame is checked for being binary rather than assumed, and the terminal path is a
single `terminate` that is idempotent by a flag. There is no `catch` fence there because there is no
attacker-controlled parse in the body to fence — the decoding all happens on `PiClient`'s side of
the handler.

## The two halves

**Make the callee total.** The decision function answers a verdict for every input rather than
throwing on some of them. `authorizeUpgrade` returns a `HandshakeVerdict` — accepted, or a refusal
naming its reason and status — for any `Host`, `Origin` and request target. Getting there means
knowing which primitives throw, and guarding the quantity they actually throw on:

- `new URL(…)` throws on an unparseable target or base. `URL.canParse` is the guard, and the base is
  a constant that always parses rather than a header the client controls.
- `crypto.timingSafeEqual` throws on unequal **byte** lengths. A percent-decoded parameter can hold a
  multibyte character, so a `String.length` pre-check passes a 64-character, 65-byte value straight
  into the throw. Compare the byte lengths — `Buffer.from(value, "utf8").length` on each side, which is what `server/token.ts` does.

Both of those shipped as a process kill on #7567, one per review round, which is why the rule is
written down rather than left to the next reader's instinct.

**Catch at the listener regardless.** Totality is a property of the code as it stands; the next edit
can add a callee that throws, and the failure mode is a crash rather than a test failure. So the
listener wraps its whole body and answers the transport's least-informative refusal:

```ts
server.on("upgrade", (request, socket, head) => {
	try {
		const verdict = authorizeUpgrade({url: request.url, headers: {…}}, token);
		if (isRefused(verdict)) return refuseUpgrade(socket, verdict);
		wss.handleUpgrade(request, socket, head, …);
	} catch {
		refuseUpgrade(socket, malformedUpgrade);
	}
});
```

The refusal says nothing the reasoned refusals do not — the catch is a fence, not a diagnostic
channel, and an error string built from a client's own bytes is what turns a crash into an oracle.

Two details the shape depends on. Destroying the socket needs its own `error` listener first: a peer
that vanished mid-handshake raises `error` on the socket, and an `error` with no listener is the same
uncaught throw. And the catch must not be able to throw itself, which is why `refuseUpgrade` checks
`destroyed` before writing.

## In Effect code, the listener only enqueues

Where the work after the callback is Effect's, the listener's whole body is an unfailable enqueue and
every decision moves onto a fiber, where a throw is a typed failure:

```ts
ws.on("message", (data: Buffer) => {
	Queue.offerUnsafe(frames, new Uint8Array(data));
});
```

`decodeFrame` then wraps the throwing `decoder.push` in `Effect.try`, turning an over-length frame
into a `FrameRefused` that names its close code. This is the preferred half wherever it fits — the
`try`/`catch` above exists because the upgrade decision has to answer *before* a WebSocket, and
therefore before there is a fiber to run it on.

## Where this stops applying

It is about listeners on a Node `EventEmitter`, in a process whose death is the failure. It does not
reach worker code: a Cloudflare isolate has no `uncaughtException` and a throw inside a request
handler fails that request alone. It is also not a licence to swallow: a `catch` that hides a bug
from a caller that *could* have handled it is worse than the crash. The fence is for the one boundary
where there is no caller.

## Testing it

Assert the property, not the instance. The unit test drives the decision function over a table of
hostile headers and targets and asserts `doesNotThrow` for each, so a new throwing callee fails a
test instead of a process
([`handshake.unit.test.ts`](../apps/tuval/src/pi/server/handshake.unit.test.ts)). The server test
then dials the real socket with the same input and asserts two things: the refusal status, and that
the server greets a *second* dial — the second half is the one that proves the process survived
([`server.unit.test.ts`](../apps/tuval/src/pi/server/server.unit.test.ts)).
