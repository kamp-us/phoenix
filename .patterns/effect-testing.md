# Testing Effect code

## The T0–T3 taxonomy ([ADR 0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md))

A tier is **which layer satisfies a fixed R-channel**, not a folder. The boundary is the workerd process boundary: T0–T2 are reachable in-process by `Effect.provide`; T3 is an HTTP URL to a separately-deployed worker (a different algebra — stack-deploy — with no R-channel).

| Tier | What it tests | Backed by | Examples |
|---|---|---|---|
| **T0 — unit (pure)** | Pure fns / Effect logic, **zero storage, no I/O** | nothing (`it`/`it.effect`) | `keyset.unit.test.ts`, `errors.unit.test.ts`, `wireCodes.unit.test.ts`, `env.unit.test.ts`, `effect.unit.test.ts`, `event-bus.unit.test.ts` |
| **T1 — service-integration** | A real feature service over a real SQL engine; only the `Database` (→ `Drizzle`) layer swaps | `node:sqlite` `:memory:` ([`sqlite-d1.fake.ts`](../apps/web/worker/db/sqlite-d1.fake.ts)) + the committed baseline migration | `Vote.test.ts`, `Drizzle.test.ts`, `sqlite-d1.fake.test.ts` |
| **T2 — bridge/app-integration** | The full worker `FateEnv` (minus the per-request trio) through `fateServer.handleRequest` — wire codes, topic publishes, real-or-stubbed better-auth | `node:sqlite` under the worker layer, no workerd | `bridge-sozluk.test.ts`, `bridge-sozluk-keyset.test.ts`, `bridge-products.test.ts`, `app.test.ts` |
| **T3 — system (stack-smoke)** | Black-box HTTP over the deployed workerd; **not a layer** | **real remote D1** + workerd | the suites under `tests/integration/` |

**T0/T1/T2 all run offline in the `unit` Vitest project** (default node pool, no workerd). T3 is the separate `integration` project — black-box HTTP against an alchemy-deployed worker, authored over the harness in [alchemy-test-harness.md](./alchemy-test-harness.md). No miniflare, no `@cloudflare/vitest-pool-workers`, no `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`. **If you're writing a T3 system test, stop reading here and go to that doc.**

The boundary that matters: **domain correctness (keyset order, `ON CONFLICT`, `COUNT(*)`, soft-delete filters) belongs in T1/T2**, not T3 — `node:sqlite` is the same engine as D1, so those are hermetically faithful, while T3 pays remote-D1 latency and seed-ordering races. Reserve T3 for genuine real-D1-only divergence (batch meta envelope, the DO+SSE+D1 composite). See ADR 0040 for the fidelity boundary in full.

Every **new or migrated** test runs offline in the `unit` project unless it genuinely needs the deployed stack. Reach for T0 first, T1 when you need real SQL, T2 when you need the wire/auth boundary, T3 only for what the in-process algebra can't reach.

## The `*.unit.test.ts` (T0) naming convention

T0 tests are tagged `*.unit.test.ts`. The `unit` project's glob (`worker/**/*.test.ts`) already catches them — the suffix is a **label, not a third project** (a third Vitest project would re-trigger Vitest 4's distinct-`sequence.groupOrder` rule; convention-first avoids it). A `*.unit.test.ts` file is a promise: pure logic, no SQL engine, no platform fake, no resource-carrying layer. T1/T2 files keep the plain `*.test.ts` suffix.

## The test-kit

App-local factories under `worker/` (graduation Gate A — rule-of-three; never a shared mock-layer instance):

- **`makeSqliteTestDb()`** ([`db/sqlite-d1.fake.ts`](../apps/web/worker/db/sqlite-d1.fake.ts)) — a fresh in-memory `node:sqlite` D1 with the baseline migration applied and `foreign_keys` forced **OFF** (D1 ships it off; `node:sqlite` defaults it on — a faithfulness fix). Returns `{d1, applyMigration, close}`. **A factory, not a shared instance** — each call is an independent `:memory:` database. Hand `d1` to `createDrizzle`, or wrap it in a `Database` layer.
- **`Database`** / **`DatabaseLive`** / **`makeDatabaseTest()`** ([`db/Database.ts`](../apps/web/worker/db/Database.ts)) — the `Database` tag holds the raw `D1Database` handle and is the single seam: both `Drizzle` and the better-auth adapter *derive* from it, so swapping one `Database` layer rebinds both (the one-`sqlite` invariant is type-enforced, ADR 0040 b1). `DatabaseLive` sources the production binding; `makeDatabaseTest()` returns a `Layer<Database>` over a fresh `makeSqliteTestDb()`, closed on scope teardown (`Layer.effect` + `Effect.acquireRelease` — `Layer.scoped` doesn't exist at this effect pin).
- **`runFateOp(workerLayer, operation, {auth?})`** ([`features/fate/run-fate-op.ts`](../apps/web/worker/features/fate/run-fate-op.ts)) — drives one fate operation through `fateServer.handleRequest` the way the `/fate` route does, in **exactly one** `Effect.provide` (a second `provide` trips the `multipleEffectProvide` lint and splits the layer-memo map). It owns the capturing `LiveBus` stub internally and returns `{status, result, published}` (`published` = the resolved topic keys the op's `live.*` fanned out to). The caller passes a fully-resolved `Layer<WorkerFateServices>` — `makeFateLayer` is zero-arg with `R = Database | BetterAuth`, so you provide a `Database` + `BetterAuth` layer to it.

## Per-test isolation: why `it.layer` is wrong

A fresh in-memory DB per test is the isolation unit. **`it.layer` builds the layer once per `describe` block** — every test in the block shares one database, so rows leak across cases. It's the wrong tool for per-test isolation regardless of shape. The two correct idioms:

- **`it.effect`-shaped (T1)** — call `freshDb()` inside the test body to build a fresh `makeDatabaseTest()`-style layer, and `provide` it to that one effect; close in `finally`. Each `it.effect` gets its own DB. Canonical: [`Vote.test.ts`](../apps/web/worker/features/vote/Vote.test.ts).
- **Promise-shaped bridge tests (T2)** — `runFateOp` is Promise-based, and a *fresh* `makeDatabaseTest()` layer rebuilt across separate `runPromise` calls would hand each call a **different** DB. So use a **stable shared handle** behind `Layer.succeed(Database)(sqlite.d1)`: `beforeEach` creates the `sqlite` handle + wraps it in a constant `Database` layer (every `runFateOp` in the test hits the *same* object reference = one database), and `afterEach` closes it. Canonical: [`bridge-sozluk.test.ts`](../apps/web/worker/features/fate/bridge-sozluk.test.ts).

In short: `makeDatabaseTest()` (rebuilds per acquisition) is for `it.effect`; `Layer.succeed(Database)(<shared handle>)` is for multi-`runPromise` bridge tests; `it.layer` is for neither when you need isolation.

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

## Which tier to write

Pick the lowest tier that exercises the behavior — the taxonomy table above is the map. In practice:

- **T0 (`*.unit.test.ts`)** — pure helpers (cursor codecs, keyset SQL building), `encodeFateError`/wire codes, the bridge resolver wrappers over a synthetic `Context`, the `liveBus` connection-procedure typing.
- **T1 (`*.test.ts`)** — a feature service driven over a real `node:sqlite` D1 (`Vote.test.ts`), the `Drizzle` `run`/`batch` contract (`Drizzle.test.ts`), the D1 fake's own meta fidelity (`sqlite-d1.fake.test.ts`).
- **T2 (`*.test.ts`)** — a fate operation through `fateServer.handleRequest` over the full worker layer (`bridge-sozluk.test.ts`, `bridge-products.test.ts`), keyset ordering on the wire (`bridge-sozluk-keyset.test.ts`), the HTTP surface (`app.test.ts`). Also the unified `LiveDO` instance factory over a `DurableObjectState` fake (`do.test.ts`).
- **T3** — only what the in-process algebra can't reach: the deployed-worker smoke + the DO+SSE+D1 composite. Black-box HTTP, see [alchemy-test-harness.md](./alchemy-test-harness.md).

All of T0–T2 run offline in the `unit` project. Don't push a deterministic-SQL or wire-code assertion up to T3 — that pays remote-D1 flake to test what `node:sqlite` covers faithfully.

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

The full service record is required — `Layer.succeed` is identity on the Tag's value shape. `Layer.succeed` is for a service whose *real* behavior is incidental to what you're testing (the resolver wrapper, an error-encoding path). If you find yourself hand-rolling a feature service's *real* behavior in a stub, that's a signal you want a real service over a real `Database` layer (T1/T2) — provide `makeDatabaseTest()` (or a shared `Database` handle), not a stub of the thing under test.

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
- **Stubbing a feature service's real behavior with `Layer.succeed` instead of running it.** Drive the real service over a real `Database` layer (T1/T2). `Layer.succeed` is for services whose behavior is incidental to the test, not for re-implementing the thing under test.
- **Filing deterministic-SQL or wire-code assertions in T3.** They belong in T1/T2, where `node:sqlite` is faithful and offline. T3 pays remote-D1 flake.
- **Setting up a unit-test layer inside `beforeEach`** when it doesn't change between tests. Module-scope it.
- **Snapshot tests against effect-internal shapes** (Causes, Exits) — they include implementation details that change between effect versions. Assert on the success value or the error `_tag`, not the cause structure.

## See also

- [ADR 0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md) — the taxonomy decision (tiers as layers, the `Database` seam, the graduation gates)
- [alchemy-test-harness.md](./alchemy-test-harness.md) — the T3 system path (black-box HTTP against the deployed worker)
- [effect-context-service.md](./effect-context-service.md) — service definition mechanics
- [feature-services.md](./feature-services.md) — the `Drizzle` service contract and its testing scope
- [effect-error-operators.md](./effect-error-operators.md) — `Exit`, `Cause`, `catchTag` used in tests
