# Effect.fn for service methods

How to write the methods inside a feature service. The short answer: `Effect.fn("Service.method")(function*(args) {...})`. The longer answer is when to deviate.

## The default — `Effect.fn("Service.method")(...)`

```ts
const addDefinition = Effect.fn("Sozluk.addDefinition")(function*(input: AddDefinitionInput) {
  const body = yield* validateBody(input.body);
  // ...
  return result;
});
```

`Effect.fn(name)` does three things:

1. **Names a span.** Every invocation creates an OpenTelemetry span called `Sozluk.addDefinition`. Free per-method tracing.
2. **Captures a stack frame.** Failures inside the function show up in the cause's stack trace with this frame visible.
3. **Returns an Effect-producing function.** The body is a generator that yields effects; the wrapper turns it into `(args) => Effect`.

Naming convention: **`Service.method`**, exactly matching the service tag's short name and the method's property name. Don't abbreviate, don't prefix with the package — the tag string already namespaces (e.g. `@kampus/sozluk/Sozluk`); the span name is for span readability in traces.

## When `Effect.fn` is the right choice

Use it for **every method on a `Context.Service`** in phoenix. Even if the body is two lines. Reasons:

- The tracing cost is negligible (~microseconds) and you only see it once per resolver call.
- A future bug investigation will want the span. Putting it in now is cheap; adding it later when half the methods don't have one is a chore.
- Consistency matters more than minor performance — a trace where every domain method shows up makes "where did the time go" instantly answerable.

Use it for **non-service helpers that are non-trivial** — the multi-statement aggregate recomputes, the validation helpers that yield multiple effects, anything that touches the DB or another service.

## When to skip — `Effect.fnUntraced` or plain functions

`Effect.fnUntraced(function*(args) {...})` has the same shape but skips the span and stack frame. Use it for:

- **Pure transforms** that return `Effect.succeed(...)` immediately — no DB, no other service. The span would just be noise.
- **Hot-path utility helpers** called dozens of times per resolver (e.g. a per-row validator). The tracing overhead is still small but the span count balloons.
- **Library code** where the consumer's span will already wrap whatever you do.

For phoenix domain code, `fnUntraced` is rare — domain methods almost always touch the DB.

Plain functions returning Effect (`const f = (x) => Effect.succeed(x + 1)`) are fine for trivial one-liners that aren't methods on a service. Don't reach for `Effect.fn` just to wrap `Effect.succeed`.

## The generator body — what goes inside `function*`

The body is a generator that yields effects. Three patterns:

### Plain yield — propagate the result, propagate failures

```ts
const body = yield* validateBody(input.body);
// `body` has the success type; failures short-circuit the surrounding function
```

### `return yield*` — terminal error

```ts
if (existing.authorId !== input.actorId) {
  return yield* new UnauthorizedDefinitionMutation({definitionId});
}
```

Without `return`, the next statement is unreachable but TypeScript won't catch it. **Always `return yield*` for terminal errors.**

### Helper composition — yield another `Effect.fn`

```ts
const addDefinition = Effect.fn("Sozluk.addDefinition")(function*(input) {
  yield* run("addDefinition.insert", () => db.insert(...));
  yield* recomputeTermSummary(input.termSlug, input.title, new Date());
  return {/* ... */};
});

const recomputeTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(function*(slug, title, now) {
  // ...
});
```

Both spans appear in the trace, nested. Helpers stay inside the layer's closure (private) unless a resolver needs them.

## What `Effect.fn` is not

- **Not a class.** It's a function constructor. Don't try to `new` it or extend it.
- **Not for top-level Effects.** If you have a single Effect at module scope (no args), just write it as `const program = Effect.gen(function*() {...})` — `Effect.fn` is for argument-taking functions.
- **Not a replacement for `Effect.gen` inline.** Inside a resolver body, `resolver(function*(_source, args) {...})` is `Generator`, not `Effect.fn`. The resolver wrapper handles the gen lifecycle. `Effect.fn` is for service methods you define separately and call multiple times.

## Naming spans well

The span name shows up in OTLP traces. Good names:

- `Sozluk.addDefinition` — service + method
- `Sozluk.recomputeTermSummary` — service + helper (private to the layer but still useful in traces)
- `addDefinition.insert` — sub-operation inside a method (used as the `operation` argument to `Drizzle.run`, which uses it for the DB-level span)

Avoid:

- Just method names (`addDefinition`) — collides with other features that have `addDefinition`.
- File paths (`features/sozluk/Sozluk/addDefinition`) — noise.
- Internal slugs (`sozluk-add-def-v2`) — meaningless to whoever is reading the trace.

## Layered tracing in practice

For one resolver call (`addDefinitionMutation`), you'll see a trace like:

```
graphql.mutation                                  150ms
  Sozluk.addDefinition                            148ms
    addDefinition.checkSlug (Drizzle.run)          5ms
    addDefinition.insert (Drizzle.run)            42ms
    Sozluk.recomputeTermSummary                    98ms
      recomputeTermSummary.selectDefs (Drizzle.run) 12ms
      recomputeTermSummary.upsert (Drizzle.run)   84ms
```

Every span has a clear owner. When something is slow, the trace tells you whether it's the SQL, the orchestration, or the resolver wrapper.

## See also

- [effect-context-service.md](./effect-context-service.md) — service definition, where `Effect.fn` methods live
- [feature-services.md](./feature-services.md) — full feature service example using `Effect.fn` throughout
- [effect-testing.md](./effect-testing.md) — span names in tests via `TestContext`
- effect-smol `Effect.fn` docs: `packages/effect/src/Effect.ts` `fn` / `fnUntraced` exports
