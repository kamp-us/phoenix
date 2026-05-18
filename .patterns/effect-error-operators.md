# Effect error operators

How to catch, inspect, and recover from errors in Effect. Covers `Effect.catchTag`, `Effect.catchTags`, `Effect.catchAll`, `Effect.exit`, and the `Exit` / `Cause` types. Read [effect-errors.md](./effect-errors.md) for the *modeling* side (tagged errors, where they live); this doc is the *handling* side.

## When to catch

Default: **don't catch.** Let errors propagate to the resolver wrapper, where they map to wire codes. Catching mid-flow usually means hiding a failure that the caller would want to know about.

Real reasons to catch in product code:

- Recovering from an *expected* failure with a fallback value (`TermNotFound → empty page` for the resolver that handles "create term on first definition").
- Wrapping a lower-layer error in a domain error (`DrizzleError → SozlukTermPersistenceError` if Sozluk wants to surface its own tag).
- Boundary translation in the resolver wrapper itself (converting tagged errors to `GraphQLError`).

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

Used when you need to inspect both branches in the same code path. The resolver wrapper does this:

```ts
// worker/graphql/resolver.ts
const exit = await context.runtime.runPromiseExit(Effect.gen(...));
if (Exit.isSuccess(exit)) return exit.value;
// ... handle failure cause
```

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
  const failure = Cause.failureOption(exit.cause);
  // failure: Option<E> — the typed error if present
  // If the failure is a defect, Option.none() — use Cause.dieOption(cause) for that.
}
```

`Cause.findError` (used by the resolver wrapper) traverses the cause tree for the first typed failure:

```ts
const errResult = Cause.findError(exit.cause);
if (errResult._tag === "Success") {
  const e = errResult.success;  // the typed error
}
```

For phoenix-level work you rarely need to construct or compose Causes — the operators above hide them. Just remember: when you see `Cause` in a signature, it's the full failure-tree model.

## Distinguishing failures from defects

```ts
Effect.fail(new MyError({}))          // typed failure → E channel
new MyError({})                       // also a typed failure when yielded (Data.TaggedError is Effect-yieldable)
throw new Error("boom")               // defect — bypasses E channel, lives in Cause
Effect.die(new Error("boom"))         // explicit defect
```

**In product code, only produce typed failures.** Throwing inside an `Effect.gen` makes the error a defect, which won't show up in your `E` channel signature and won't be caught by `Effect.catchTag`. The resolver wrapper will still catch it via `Cause.squash` but you've lost type safety.

## How the resolver wrapper uses these

`worker/graphql/resolver.ts` is the canonical pattern for "consume an Effect at a system boundary":

```ts
const exit = await context.runtime.runPromiseExit(Effect.gen(() => body(source, args)));
if (Exit.isSuccess(exit)) return exit.value;

const errResult = Cause.findError(exit.cause);
if (errResult._tag === "Success") {
  const e = errResult.success;
  if (e instanceof GraphQLError) throw e;
  throw encodeMutationError(e);
}
// defect path
throw encodeMutationError(Cause.squash(exit.cause));
```

What this does:

1. Run the resolver Effect, getting an `Exit` back. Never throws.
2. Success → return the value.
3. Typed failure → find it in the cause tree, route through `encodeMutationError` (which switches on `_tag`).
4. Defect → squash the cause to a single error, route through the same encoder.

If you find yourself writing similar boundary-handling code elsewhere (e.g., admin routes), use this as the template.

## Anti-patterns

- **`Effect.catchAll` to convert errors into a generic "operation failed" string.** You've thrown away the diagnostic value. Use `catchTags` to handle the cases you know, let the rest propagate.
- **Catching `DrizzleError` inside a feature method.** Drizzle errors indicate infrastructure failure. Hiding them produces silent corruption. Let them propagate; the resolver maps to `INTERNAL_ERROR`.
- **Throwing inside an `Effect.gen` to "fail fast."** Use `return yield* new MyError({})` instead. Throws become defects, which TS can't reason about.
- **Using `Effect.exit` everywhere just to be safe.** Most code should propagate failures naturally. Reach for `exit` only at boundaries (resolver wrapper, tests asserting on failures).

## See also

- [effect-errors.md](./effect-errors.md) — defining tagged errors
- [effect-testing.md](./effect-testing.md) — using `Effect.exit` and `Cause` in tests
- `worker/graphql/resolver.ts` — production usage of the boundary pattern
