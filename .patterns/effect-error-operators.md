# Effect error operators

How to catch, inspect, and recover from errors in Effect. Covers `Effect.catchTag`, `Effect.catchTags`, `Effect.catchAll`, `Effect.exit`, and the `Exit` / `Cause` types. Read [effect-errors.md](./effect-errors.md) for the *modeling* side (tagged errors, where they live); this doc is the *handling* side.

## When to catch

Default: **don't catch.** Let errors propagate to the fate boundary, where `encodeWireError` maps them to wire codes. Catching mid-flow usually means hiding a failure that the caller would want to know about.

Real reasons to catch in product code:

- Recovering from an *expected* failure with a fallback value (`TermNotFound → empty page` for the resolver that handles "create term on first definition").
- Wrapping a lower-layer error in a domain error (`DrizzleError → SozlukTermPersistenceError` if Sozluk wants to surface its own tag).
- Boundary translation at the fate interpreter itself — encoding a tagged error to its wire code via the `FateWireCode` annotation ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)).

Catching infra errors (`DrizzleError`) inside domain methods almost always means hiding a real problem. Let it fall through.

## `Effect.catchTag` — handle one tag

```ts
const result = yield* getTerm(slug).pipe(
  Effect.catchTag("sozluk/TermNotFound", () => Effect.succeed(emptyTermPage(slug))),
);
```

`Effect.catchTag(tag, handler)`:

- Removes that specific tag from the resulting `E` channel.
- Replaces it with whatever the handler returns (success value or another failure).
- Type-narrows the handler's argument to the matching error class, so you can access typed fields.

```ts
yield* mutation.pipe(
  Effect.catchTag("sozluk/BodyTooLong", (err) =>
    Effect.fail(new ValidationFailure({
      field: "body",
      max: err.max,  // typed access — `err` is BodyTooLong here
    })),
  ),
);
```

## `Effect.catchTags` — handle multiple

```ts
yield* operation.pipe(
  Effect.catchTags({
    "sozluk/TermNotFound": () => Effect.succeed(fallback),
    "sozluk/DefinitionNotFound": (err) => Effect.fail(new UserVisibleError({id: err.definitionId})),
  }),
);
```

Cleaner than chained `catchTag`s when handling several at once. Each handler is type-narrowed to its tag.

## `Effect.catchAll` — last resort

```ts
yield* riskyOperation.pipe(
  Effect.catchAll((err) => {
    // err is the entire E channel union
    return Effect.logError("Operation failed", err).pipe(
      Effect.andThen(Effect.succeed(defaultValue)),
    );
  }),
);
```

`Effect.catchAll` removes *every* error from the channel. Use sparingly — it hides specificity. Prefer `catchTag`/`catchTags` so future error additions force you to update handlers explicitly.

Defects (uncaught throws that bypass the `E` channel) are *not* caught by `catchAll`. Use `Effect.catchAllCause` for that — but if you're catching defects in product code, something's wrong.

## `Effect.exit` — convert failure to a value

```ts
const exit = yield* Effect.exit(mayFail);
// exit: Exit<A, E>, never fails — wraps both success and failure as data.
if (Exit.isSuccess(exit)) {
  doSomething(exit.value);
} else {
  inspectFailure(exit.cause);
}
```

Used when you need to inspect both branches in the same code path — most often a test asserting on a failure ([effect-testing.md](./effect-testing.md)). At the serving boundary you rarely reach for `Effect.exit` directly: the fate interpreter runs each operation on the request fiber and, on failure, pulls the value off the `Cause` (see below) and hands it to `encodeWireError`. There is no per-request runtime and no `Effect`→`Promise` hop on the serving path (ADR 0043 — the lone `runtime.runPromise` survives only in the oracle baseline's `Executor.ts`). See [fate-effect-interpreter.md](./fate-effect-interpreter.md).

## `Exit` and `Cause` — the failure model

When an Effect fails, the failure is wrapped in a `Cause`. Cause supports:

- **Single failures** (a typed error from `Effect.fail`)
- **Defects** (uncaught throws, from `Effect.die` or thrown JS errors)
- **Interrupts** (cancellation)
- **Compound failures** (parallel effects failing simultaneously)

Most code only cares about the typed failure case:

```ts
import {Cause, Exit} from "effect";

const exit = yield* Effect.exit(operation);
if (Exit.isFailure(exit)) {
  const failure = Cause.findErrorOption(exit.cause);
  // failure: Option<E> — the first typed error if present, else Option.none()
  // for a pure-defect cause. `Cause.squash(cause)` collapses a cause to one value.
}
```

`Cause.findError` traverses the cause tree for the first typed failure, returning a `Result` whose `_tag === "Success"` carries the typed error on `.success`:

```ts
const errResult = Cause.findError(exit.cause);
if (errResult._tag === "Success") {
  const e = errResult.success;  // the typed error
}
```

At the fate boundary this extraction is packaged once as `failureOf(cause)` (`packages/fate-effect/src/WireError.ts`): the typed failure if one exists (`Cause.findErrorOption`), otherwise the squashed defect (`Cause.squash`) — whatever it returns feeds straight into `encodeWireError` ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)).

For phoenix-level work you rarely need to construct or compose Causes — the operators above hide them. Just remember: when you see `Cause` in a signature, it's the full failure-tree model.

## Distinguishing failures from defects

```ts
Effect.fail(new MyError({}))          // typed failure → E channel
new MyError({})                       // also a typed failure when yielded (Data.TaggedError is Effect-yieldable)
throw new Error("boom")               // defect — bypasses E channel, lives in Cause
Effect.die(new Error("boom"))         // explicit defect
```

**In product code, only produce typed failures.** Throwing inside an `Effect.gen` makes the error a defect, which won't show up in your `E` channel signature and won't be caught by `Effect.catchTag`. `encodeWireError` will still collapse it via `Cause.squash` at the boundary, but you've lost type safety.

## How the fate boundary uses these

`FateInterpreter.handleRequest` (the `POST /fate` serving plane, ADR 0043 — [fate-effect-interpreter.md](./fate-effect-interpreter.md)) is the canonical pattern for "consume an Effect at a system boundary". Its dispatch loop runs each operation on the request fiber and maps a failed operation onto fate's protocol error shape:

```ts
// packages/fate-effect — dispatch (paraphrased)
const value = failureOf(cause);        // typed failure, else squashed defect
const wire = encodeWireError(value);   // → FateRequestError { code, message }
```

What this does:

1. Run each operation on the request fiber — no `runPromiseExit`, no per-request runtime; the caller owns the one run boundary (ADR 0043).
2. Success → the value is serialized into the operation's result.
3. Failure → `failureOf(cause)` pulls the failed/thrown value off the `Cause`, then `encodeWireError` maps it to a wire code: an error class carrying a `FateWireCode` annotation encodes to that code plus its own `message`; anything un-annotated (or a defect) collapses to `INTERNAL_SERVER_ERROR` with a fixed message, so defect details never reach the wire ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)).

`encodeWireError` is total — it never throws, whatever the failed/thrown value — so the boundary always produces a well-formed protocol error. If you write similar boundary-handling code elsewhere (e.g., a typed-JSON `HttpApi` group), reach for the same `failureOf` → `encodeWireError` shape rather than re-deriving it.

## Anti-patterns

- **`Effect.catchAll` to convert errors into a generic "operation failed" string.** You've thrown away the diagnostic value. Use `catchTags` to handle the cases you know, let the rest propagate.
- **Catching `DrizzleError` inside a feature method.** Drizzle errors indicate infrastructure failure. Hiding them produces silent corruption. Let them propagate; `encodeWireError` maps the un-annotated failure to `INTERNAL_SERVER_ERROR` at the boundary.
- **Throwing inside an `Effect.gen` to "fail fast."** Use `return yield* new MyError({})` instead. Throws become defects, which TS can't reason about.
- **Using `Effect.exit` everywhere just to be safe.** Most code should propagate failures naturally. Reach for `exit` only at boundaries (the fate interpreter, tests asserting on failures).

## See also

- [effect-errors.md](./effect-errors.md) — defining tagged errors
- [effect-testing.md](./effect-testing.md) — using `Effect.exit` and `Cause` in tests
- [fate-effect-wire-errors.md](./fate-effect-wire-errors.md), [fate-effect-interpreter.md](./fate-effect-interpreter.md) — the fate boundary's error encoding + dispatch
