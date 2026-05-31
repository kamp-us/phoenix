# Testing Effect code

Phoenix has two test projects (`apps/web/vitest.config.ts`):

- **Integration** — black-box HTTP against a real alchemy-deployed worker. Authored over the harness in [alchemy-test-harness.md](./alchemy-test-harness.md). No miniflare, no `@cloudflare/vitest-pool-workers`, no `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`. **If you're writing an integration test, stop reading here and go to that doc.**
- **Unit** — pure helpers, the `Drizzle` service contract, the fate bridge over a `node:sqlite` D1, the live-DO instance factories over a state fake. This doc covers the unit project.

The integration path supersedes the prior miniflare recipe; this doc keeps only the unit-level Effect-testing guidance.

## `@effect/vitest` and `it.effect`

`@effect/vitest` extends vitest with Effect-native test functions. The key one is `it.effect`:

```ts
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";

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
- **Use `assert`, not `expect`, inside `it.effect` blocks.** `expect`'s async behavior interacts badly with Effect's runtime. `assert.strictEqual`, `assert.deepStrictEqual`, `assert.isTrue`, etc. work as expected. Integration tests (the HTTP harness) use vitest's stock `it` + `expect` — see [alchemy-test-harness.md](./alchemy-test-harness.md).
- **Use `it` (not `it.effect`)** for pure-function tests that don't return Effects. Both forms can coexist in the same file.

## When to write a unit test (and when to reach for integration instead)

Unit tests are right for code with no platform dependency — pure helpers, the trust-boundary contracts of `Drizzle` / the fate bridge, the live-DO instance factories. They drive Effects with `it.effect` and synthetic layers; they never deploy a worker.

Product code that touches D1, the DOs, or the fate seam belongs in the integration project — black-box HTTP against the deployed worker (see [alchemy-test-harness.md](./alchemy-test-harness.md)). Don't reach for `Layer.succeed(Service, …)` stubs to test a feature service; integration is the default for product code.

The remaining unit-test slots, in practice:

- The `Drizzle` service's `run` / `batch` contract (`apps/web/worker/db/Drizzle.test.ts`).
- The fate bridge over a `node:sqlite`-backed D1 fake.
- The unified `LiveDO` instance factory over a `DurableObjectState` fake (`apps/web/worker/features/fate-live/do.test.ts`).
- Pure helpers (cursor codecs, keyset pagination, etc.).

## Stubbing a service when you genuinely need to

When a unit test is exercising one layer of logic in isolation — testing the resolver wrapper, an error-encoding path, the bridge over a fake D1 — `Layer.succeed` is the right tool:

```ts
const TestSozluk = Layer.succeed(Sozluk, {
  getTerm: () => Effect.succeed(null),
  addDefinition: (input) =>
    input.body.trim() === ""
      ? Effect.fail(new BodyRequired())
      : Effect.succeed({/* fixture */}),
  // ... full service record
});

it.effect("validation error surfaces to bridge", () =>
  someBridgeEffect.pipe(Effect.provide(TestSozluk)),
);
```

The full service record is required — `Layer.succeed` is identity on the Tag's value shape. If you find yourself reaching for `Layer.succeed` on a feature service in product-code tests, that's a signal you want integration, not a unit test.

## Testing the `Drizzle` service (infrastructure)

`run` and `batch` (the bound methods on the `Drizzle` service value) are the trust boundary. Test them in isolation against a fake/in-memory drizzle setup. See the [feature-services.md](./feature-services.md#the-drizzle-service) testing-scope notes — scope B (smoke + semantics + composition + type inference + error propagation), ~10-15 tests.

Tests build a `Drizzle` layer over a test-supplied `db` via the production factories (`makeDrizzleAccess` / `makeDrizzleLayer` in `worker/db/Drizzle.ts`) — the test layer is exactly the production wiring with a fake `DrizzleDb`, so the `run` / `batch` bodies under test are the ones that ship.

Canonical implementation: `apps/web/worker/db/Drizzle.test.ts`.

## Helpers in test files

- **Service fixtures** — small builder functions that return realistic input shapes. Live at the top of the test file or in a sibling `fixtures.ts`. Pure functions, plain TS, no Effect needed.
- **Seed helpers** — wrap calls to the *real* services. `seedTerm(sozluk, slug, defs)` is an Effect that calls `sozluk.addDefinition` multiple times. Lives next to the test that uses it. (In integration tests the equivalent is the harness's `h.seedTerm(...)` — see [alchemy-test-harness.md](./alchemy-test-harness.md).)
- **Test layer vs. platform fake — the distinction IS the rule.** An Effect **service**'s test seam is a **TestLayer**: a `Layer.succeed(Service, impl)` (or `Layer.effect`) that provides the service with a test implementation — the layer *is* the seam (see "Stubbing a service" above). Name it `Test<Service>` / `<Service>Test`, define it next to the test that drives it, and provide it with `Effect.provide`. **Never** model a service's test double as a loose fake object or "fake effect" — wrap it in its layer. A standalone **fake** is reserved for a non-Effect **platform type** you can't express as a service — the raw `D1Database`, a `DurableObjectState`. Those live in a **colocated `*.fake.ts`** exporting a `makeXxx()` factory (`worker/db/sqlite-d1.fake.ts`, `worker/features/fate-live/do-state.fake.ts`); the service built *over* the fake (e.g. `Drizzle`) is still provided by a TestLayer. The `.fake.ts` suffix keeps the platform fake out of the vitest `*.test.ts` glob while staying type-checked; per-line `// biome-ignore lint/plugin:` justifies any boundary cast inside it.
- **No `__support__/`, `__tests__/`, `test-utils/`, or top-level `test/` folder** for either — that's layered-folder drift ([[feedback_colocate_over_layered_folders]]); colocate test layers + platform fakes by feature.
- **Don't share mock layers across files** — if two tests need the same service *stub* (a `Layer.succeed(Service, …)`), that's a smell that maybe a fixture or seed helper is the better abstraction. (A platform *fake* — a real in-memory `D1Database`/`DurableObjectState` — is fine to share via a `*.fake.ts`.)

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
- **Reaching for `Layer.succeed(FeatureService, …)` to test product code.** That's a unit test pretending to be integration. Use the HTTP harness.
- **Setting up a unit-test layer inside `beforeEach`** when it doesn't change between tests. Module-scope it.
- **Snapshot tests against effect-internal shapes** (Causes, Exits) — they include implementation details that change between effect versions. Assert on the success value or the error `_tag`, not the cause structure.

## See also

- [alchemy-test-harness.md](./alchemy-test-harness.md) — the integration path (black-box HTTP against the deployed worker)
- [effect-context-service.md](./effect-context-service.md) — service definition mechanics
- [feature-services.md](./feature-services.md) — testing-strategy decision (integration for product, isolation for infra)
- [effect-error-operators.md](./effect-error-operators.md) — `Exit`, `Cause`, `catchTag` used in tests
