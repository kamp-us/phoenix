# An Effect layer over a Promise SDK that owns a subprocess

How to wrap a dependency that (a) hands you an async generator you cannot interrupt, (b) calls
*your* `async` callback and blocks on the promise you return, and (c) owns a child process whose
death you only learn about by the generator ending.

The instance is
[`apps/tuval/src/claude/agent/ClaudeAiAgent.ts`](../apps/tuval/src/claude/agent/ClaudeAiAgent.ts),
the `TuvalAiAgent` layer over `@anthropic-ai/claude-agent-sdk`. The three rules below are the ones a
reader gets wrong by following the ordinary layer idiom, and each one cost a debugging round to
find.

## 1 — Fork the pump into the session's scope, not the layer's

The obvious shape is `Effect.forkIn(pump, layerScope)`, as
[`.patterns/effect-context-service.md`](./effect-context-service.md) implies for a layer-lifetime
fiber. **It deadlocks here.**

A pump that reads an async generator sits in `Effect.tryPromise(() => iterator.next())`. Nothing
aborts a running async generator, so that await is not interruptible: the fiber resumes only when
the generator yields or ends, and the generator ends only when you call the SDK's own `close()`.
Scope finalizers run last-registered-first, and `forkIn` registers the fiber's interruption *after*
the layer's build-time finalizers — so the scope tries to interrupt-and-await a fiber that is
waiting on a subprocess nobody has told to stop. Both halves are readable at the pin
(`effect@4.0.0-rc.112`, `dist/internal/effect.js`): `scopeCloseFinalizers` walks the registered
finalizers from `arr.length - 1` down to `0`, and `forkIn` registers the fiber's interrupt through
`scopeAddFinalizerUnsafe` at fork time, which is after the layer's build already registered its
own.

The fix is to give the session its own scope and close it in order:

```ts
const current: Session = {…, scope: yield* Scope.make()};
yield* Effect.forkIn(pump(…), current.scope);

// teardown, in this order and no other
held.handle.close();                     // ends the generator
yield* Scope.close(held.scope, Exit.void); // now the fiber is finishing, not blocked
```

Exactly-once teardown is `Ref.getAndSet(session, null)`: the lane that takes the session non-null is
the lane that closes it, so a scope close racing a re-`start` still calls the SDK's `close()` once.

## 2 — Park a blocking callback's resolver synchronously, in a plain `Map`

An SDK that asks permission calls your callback and awaits its promise. The callback runs on no
fiber of yours, and it must have parked its resolver **before it returns** — the abort signal can
fire on the very next tick.

So the pending table is a plain `Map`, not a `Ref`: a `Ref.update` is scheduled onto a fiber, and
that schedule loses the race. Every mutation of the map is synchronous, which on one JS thread is
the atomicity a `Ref` would have bought.

```ts
const parked = new Map<string, Parked>();

const callback = (…, context) =>
  new Promise<Result>((resolve) => {
    parked.set(context.id, {resolve, …});          // synchronous, before anything else
    context.signal.addEventListener("abort", onAbort, {once: true});
    void runtime.runPromise(publish([card]));      // the Effect half, after
  });
```

`runtime` is `{runPromise: Effect.runPromiseWith(yield* Effect.context<never>())}` — the layer's own
services, so a callback keeps the caller's spans and loggers instead of running on a bare runtime.

Answering and aborting both go through one `take-then-resolve` step, and the `Map.delete` is what
decides who won:

```ts
const settle = (request, decision) => Effect.suspend(() => {
  const held = parked.get(request);
  if (held === undefined) return Effect.succeed(false);   // already answered, or never existed
  parked.delete(request);
  held.resolve(resultOf(decision, held));
  return Effect.as(publish([resolved(request, decision)]), true);
});
```

Closing the scope settles every remaining entry with the fail-closed answer. An unresolved callback
is not a leak the runtime cleans up — the dependency blocks on it forever.

## 3 — Tell a deliberate close from a subprocess that died

The generator ends the same way in both cases, so the difference has to be state you keep:

- `closing` — set by your own teardown before `close()`.
- `settled` — false when a turn is in flight, true once the dependency reports the turn's result.

`closing || settled` ends the stream (`Queue.end`); anything else fails it with a transport error.
Without this a deliberate teardown reads as a crash, and a crash mid-turn reads as a clean exit.

The exit *reason* needs a second seam. The SDK owns the spawn, so the only place to observe it is
its own spawn hook — wrap the spawner rather than replacing it, and leave the hook unset when the
row supplies none, so the dependency's default spawn stands:

```ts
export const watchSubprocess = (spawn) => {
  let exit: ExitRecord | null = null;
  return {
    spawn: (options) => {
      const child = spawn(options);
      child.once("exit", (code, signal) => { exit = {code, signal}; });
      return child;
    },
    exit: () => exit,
  };
};
```

## 4 — One seam for the SDK, one for the subprocess

Two different tests need two different fakes, and collapsing them into one hides a whole half.

- **The SDK seam** (`{query, getSessionMessages, version}`) defaults to the real module. A test hands
  in a scripted generator replaying golden fixtures
  ([`.patterns/golden-real-payload-fixtures.md`](./golden-real-payload-fixtures.md)) and records the
  options it was opened with — which is the only way to assert what the layer handed the dependency.
- **The spawn seam** is the dependency's own hook. A fake that records a spawn and a kill and never
  speaks the protocol proves the lifetime half at unit speed, so nothing here enters the real-spawn
  tier ([`.patterns/subprocess-test-budget.md`](./subprocess-test-budget.md)).

Build the scripted generator with a real `async function*` and `Object.assign` the control methods
onto it. A hand-written iterator object cannot satisfy `AsyncGenerator`'s `next`/`return`/`throw`
overloads without a cast, and a cast in a fixture is a fixture that stops checking.

## The version constant

A dependency whose `package.json` is not in its `exports` map cannot have its version imported. Write
it as one constant and pin it in a test against both the `pnpm-workspace.yaml` catalog entry and the
installed manifest — a constant nothing checks goes stale the first time the catalog moves, and here
it is the value a log line reports as SDK/CLI drift.
