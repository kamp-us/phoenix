# Testing Effect code

Phoenix's testing strategy:

- **Product code** (feature services, resolvers, helpers used by features) → integration tests via miniflare + the live runtime. No mocking, no layer swaps for testability. Real D1, real services.
- **Infrastructure** (`Drizzle` service, resolver wrapper, runtime wiring) → isolation tests. Direct verification of contracts that everything else depends on.

Don't write helpers in extracted files just to test them. See [feature-services.md](./feature-services.md) on the extraction policy.

## `@effect/vitest` and `it.effect`

`@effect/vitest` extends vitest with Effect-native test functions. The key one is `it.effect`:

```ts
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";

describe("Sozluk.addDefinition", () => {
  it.effect("rejects empty body", () =>
    Effect.gen(function*() {
      const sozluk = yield* Sozluk;
      const exit = yield* Effect.exit(sozluk.addDefinition({body: "  ", /* ... */}));
      assert.strictEqual(Exit.isFailure(exit), true);
    }),
  );
});
```

Rules:

- **Use `it.effect`** for any test whose body returns an Effect. The runner runs it through Effect's internal interpreter.
- **Don't use `Effect.runSync` / `Effect.runPromise`** inside `it`. That bypasses the test runner's tracing and timing.
- **Use `assert`, not `expect`,** inside `it.effect`. `expect`'s async behavior interacts badly with Effect's runtime. `assert.strictEqual`, `assert.deepStrictEqual`, `assert.isTrue`, etc. work as expected.
- **Use `it` (not `it.effect`)** for pure-function tests that don't return Effects. Both forms can coexist in the same file.

## Integration tests — the dominant case

Phoenix's `tests/integration/*.test.ts` files are the bulk of the test suite. They hit miniflare's real D1 and exercise feature services through the GraphQL schema or admin runtime.

Pattern:

```ts
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {VoteLive} from "../../worker/features/vote/Vote";
import {DrizzleLive} from "../../worker/services/Drizzle";
import {CloudflareEnv} from "../../worker/services/CloudflareEnv";

const TestLive = Layer.mergeAll(SozlukLive, VoteLive).pipe(
  Layer.provide(DrizzleLive),
  Layer.provide(Layer.succeed(CloudflareEnv, getMiniflareEnv())),
);

describe("Sozluk integration", () => {
  it.effect("adds a definition and recomputes term aggregates", () =>
    Effect.gen(function*() {
      const sozluk = yield* Sozluk;
      const result = yield* sozluk.addDefinition({
        termSlug: "test",
        authorId: "user-1",
        authorName: "tester",
        body: "first definition",
      });

      assert.strictEqual(result.termCreated, true);

      const page = yield* sozluk.getTerm("test");
      assert.strictEqual(page?.totalDefinitions, 1);
    }).pipe(Effect.provide(TestLive)),
  );
});
```

Notes:

- **`Layer.provide` order matters.** Outermost in the pipe is what's actually provided. Reading inside-out: `SozlukLive + VoteLive` need `Drizzle`; `Drizzle` needs `CloudflareEnv`. Pipe each `Layer.provide` to satisfy the next dep down.
- **Build the test layer once at module scope.** Don't reconstruct it per test. Per-test setup (seeding fixtures) goes inside the `it.effect` body via service method calls.
- **Don't mock the services.** Integration tests use the live layers. Mocking is for the rare unit tests below.

## Unit tests — when integration is genuinely overkill

If a test is exercising pure validation logic that lives inside a service method, and the integration test path requires significant fixture setup, you *can* swap the service with `Layer.succeed`:

```ts
const TestSozluk = Layer.succeed(Sozluk, {
  getTerm: () => Effect.succeed(null),
  addDefinition: (input) =>
    input.body.trim() === ""
      ? Effect.fail(new BodyRequired())
      : Effect.succeed({/* fixture */}),
  // ... full service record
});

it.effect("validation error surfaces to resolver", () =>
  someResolverEffect.pipe(Effect.provide(TestSozluk)),
);
```

But this is the **exception**, not the default. The recommendation from [feature-services.md](./feature-services.md) — and the project's testing philosophy — is integration via miniflare unless you have a specific reason to isolate. Reasons that count: testing the resolver wrapper itself, testing the Drizzle service's prototype contract, testing error-encoding logic.

## Testing the `Drizzle` service (infrastructure)

`Drizzle.run` and `Drizzle.batch` are the trust boundary. Test them in isolation against a fake/in-memory drizzle setup. See the [feature-services.md](./feature-services.md#the-drizzle-service) testing-scope notes — scope B (smoke + semantics + composition + type inference + error propagation), ~10-15 tests.

```ts
describe("Drizzle.run", () => {
  it.effect("yields callback's promise result", () =>
    Effect.gen(function*() {
      const result = yield* Drizzle.run((db) => Promise.resolve(42));
      assert.strictEqual(result, 42);
    }).pipe(Effect.provide(TestDrizzleLive)),
  );

  it.effect("wraps rejection as DrizzleError", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Drizzle.run(() => Promise.reject(new Error("boom"))),
      );
      if (Exit.isSuccess(exit)) {
        assert.fail("expected failure");
      }
      const err = Cause.failureOption(exit.cause);
      assert.strictEqual(Option.getOrThrow(err)._tag, "@phoenix/Drizzle/Error");
    }).pipe(Effect.provide(TestDrizzleLive)),
  );

  // ... composition, type inference, batch variant
});
```

## Helpers in test files

- **Service fixtures** — small builder functions that return realistic input shapes. Live at the top of the test file or in a sibling `fixtures.ts`. Pure functions, plain TS, no Effect needed.
- **Seed helpers** — wrap calls to the *real* services. `seedTerm(sozluk, slug, defs)` is an Effect that calls `sozluk.addDefinition` multiple times. Lives next to the test that uses it.
- **Don't share mock layers across files** — if two tests need the same service stub, that's a smell that maybe a fixture or seed helper is the better abstraction.

## TestClock and time-dependent tests

For anything time-sensitive (TTL expiry, debouncing, scheduled work), use `TestClock` from `effect/TestContext`:

```ts
import {TestClock, TestContext} from "effect";

it.effect("expires after 1 hour", () =>
  Effect.gen(function*() {
    const result = yield* doSomethingWithTtl;
    yield* TestClock.adjust(Duration.hours(2));
    const expired = yield* checkStatus;
    assert.strictEqual(expired, "expired");
  }).pipe(Effect.provide(TestContext.TestContext)),
);
```

Never use `setTimeout`, `Date.now()`, or real wall-clock sleeps in tests. `TestClock` virtualizes time; assertions become deterministic.

## Anti-patterns

- **`Effect.runSync(effect)` inside `it(...)`.** Use `it.effect` instead.
- **`expect(...).toBe(...)` inside `it.effect`.** Use `assert.strictEqual` etc.
- **Setting up the test layer inside `beforeEach`** when it doesn't change between tests. Module-scope it.
- **Mocking the `Drizzle` service** to "avoid hitting D1" for integration tests. Integration tests should hit D1. If you're mocking it, you've slid into a unit test pretending to be integration.
- **Snapshot tests against effect-internal shapes** (Causes, Exits) — they include implementation details that change between effect versions. Assert on the success value or the error `_tag`, not the cause structure.

## See also

- [effect-context-service.md](./effect-context-service.md) — service definition mechanics
- [feature-services.md](./feature-services.md) — testing-strategy decision (integration for product, isolation for infra)
- [effect-error-operators.md](./effect-error-operators.md) — `Exit`, `Cause`, `catchTag` used in tests
- `tests/integration/*.test.ts` — existing integration tests as reference
