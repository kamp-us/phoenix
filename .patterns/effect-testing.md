# Testing Effect code

## Two tiers — `unit` and `integration` ([ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md))

Two tiers, no middle, **no faked engine**. The split is whether a test needs a database at all:

| Tier | What it tests | Backed by | Examples |
|---|---|---|---|
| **`unit`** | Pure logic and Effect control flow — **no database, no SQL engine, no I/O**. The unit under test sits on a seam whose lower layer is substituted directly (the `Database` / `Drizzle` seam is already mockable — a `Layer.succeed(Drizzle, …)` with a recording or throwing `run`). | nothing — the seam below is substituted (`Layer.succeed(Drizzle, …)`) | `keyset.unit.test.ts`, `pasaport/errors.unit.test.ts`, `env.unit.test.ts`, `Vote.unit.test.ts`, `Drizzle.unit.test.ts`, `live-publisher.unit.test.ts`, `queries.unit.test.ts` |
| **`integration`** | Real behavior against **real remote Cloudflare D1**, the deployed worker, the DOs, and the fate seam — black-box over HTTP | **real remote D1** + the deployed workerd, via alchemy `Test.make` (per-file isolated stage) | the suites under `tests/integration/` |

**`unit` runs offline** in the `unit` Vitest project (default node pool, no workerd, no database). **`integration`** is the separate `integration` project — black-box HTTP against an alchemy-deployed worker, authored over the harness in [alchemy-test-harness.md](./alchemy-test-harness.md). No miniflare, no `@cloudflare/vitest-pool-workers`, no `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`. **If you're writing an integration test, stop reading here and go to that doc.**

**`node:sqlite` is banned outright as a test backing** (ADR 0082). The old four-tier T0–T3 taxonomy (ADR 0040, superseded) blessed an in-process `node:sqlite` D1 stand-in (`makeSqliteTestDb`) as the backing for "service-" and "app-integration" tests; that premise — *"`node:sqlite` is the same engine as D1, so domain correctness belongs on a faked engine"* — was wrong (different FTS5 build, tokenizer, and collation), and it put domain logic on a database that didn't need one. `makeSqliteTestDb` / `apps/web/worker/db/sqlite-d1.testing.ts` are **deleted**; a test that boots any SQL engine is not a unit test.

The litmus for tier placement (ADR 0082): **"Could this be wrong even if the database behaved perfectly?"** — yes (normalization, clamping, envelope shaping, pagination/keyset *decisions*, auth gates, cursor-miss branches, topic-key routing) → `unit`; only-wrong-if-the-real-D1-differs (FTS5 MATCH/bm25, collation/NULL/date tiebreaks in keyset *execution*, batch atomicity, `meta.changes` idempotency, the better-auth session round-trip) → `integration`. **No domain decision welded to SQL execution:** cursor resolution is a *port* (a thin DB read), but the keyset / cursor-miss *decision* and the page envelope are *pure* and unit-testable.

Reach for `unit` first — only push to `integration` what the in-process algebra genuinely can't reach faithfully.

## The `*.unit.test.ts` naming convention

Unit tests are tagged `*.unit.test.ts`. The `unit` project's glob (`worker/**/*.test.ts`) already catches them — the suffix is a **label, not a separate project** (a distinct project would re-trigger Vitest 4's distinct-`sequence.groupOrder` rule; convention-first avoids it). A `*.unit.test.ts` file is a promise: pure logic, no SQL engine, no platform fake, no resource-carrying layer. The few remaining plain `*.test.ts` files under `worker/` (`features/fate-live/do.test.ts` over a `DurableObjectState` fake, `features/fate/codegen-vite.test.ts`) are also in the `unit` glob and likewise boot no database.

## The unit-tier seam: substitute `Drizzle` directly

A `unit` test never builds a database — it substitutes the seam **below** the unit under test with a `Layer.succeed(Drizzle, …)` whose `run` / `batch` are recording or throwing test doubles. That is how you exercise a service's *decisions* with no engine.

- **`Database`** / **`DatabaseLive`** ([`db/Database.ts`](../apps/web/worker/db/Database.ts)) — the `Database` tag holds the raw `D1Database` handle and is the single seam: both `Drizzle` and the better-auth adapter *derive* from it (the one-`sqlite` invariant is type-enforced). `DatabaseLive` sources the production binding. **`unit` tests do not provide a `Database` layer** — there is no faked `D1Database` to put under it (the `node:sqlite` fake is deleted, ADR 0082); they substitute the higher `Drizzle` seam instead. The real `Database` only ever runs at the `integration` tier, against real remote D1.
- **A throwing `Drizzle`** — a `DrizzleAccess` whose every `run` / `batch` `Effect.die`s. Provide it so that any path which *should* short-circuit before touching the DB fails loudly if it doesn't — running to completion against it is the "no read / no write" proof.
- **A scripted `Drizzle`** — a `DrizzleAccess` whose `run` replays a queued sequence of fixture results (and whose `batch` throws), feeding a decision its DB inputs without an engine. The canonical pair lives at the top of [`Vote.unit.test.ts`](../apps/web/worker/features/vote/Vote.unit.test.ts) (`throwingAccess`, `scriptedAccess`) — the `Drizzle.test.ts` half-A idiom.

`runFateOp` ([`features/fate/run-fate-op.ts`](../apps/web/worker/features/fate/run-fate-op.ts)) still exists as the in-process mirror of the `/fate` route (drives one fate operation through `fateServer.handleRequest` in exactly one `Effect.provide`), but it is **no longer a test backing** — the fate-op behaviors it once exercised over the faked engine now run at the `integration` tier on real D1.

## Per-test isolation

`unit` tests carry no per-test database to isolate, so there is no shared-handle lifecycle to manage: each test provides its own `Layer.succeed(Drizzle, …)` double inline. Module-scope a double that doesn't vary between tests; build it inside the test body when the scripted results differ per case.

**`it.layer` builds the layer once per `describe` block** — fine for a stable stub, but if a test ever needed a fresh stateful resource per case, `it.layer` would share one across the block. At the `integration` tier, isolation is the per-file `Test.make` stage, not anything in this file — see [alchemy-test-harness.md](./alchemy-test-harness.md).

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

## Fiber coordination: await events, never durations

A test that needs "the fiber has started" (or any point-in-execution fact) must wait on an
**event the program itself emits**, never on a timer that hopes the runtime got there. A fixed
`setTimeout(0)` tick lost the race against fiber startup on a loaded CI runner exactly once —
which is once per however many thousand runs, always on the runner you can't reproduce.

The primitive is `Latch`: the program opens it as its first instruction; awaiting it IS the
proof the fiber is running.

```ts
import * as Latch from "effect/Latch";

it.effect("an abort mid-flight interrupts the program", () =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const started = yield* Latch.make();
    const program = started.open.pipe(Effect.andThen(Effect.never));
    const fiber = yield* Effect.forkChild(program.pipe(interruptOnAbort(controller.signal)));
    yield* started.await; // deterministic on any runner speed
    controller.abort();
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Exit.hasInterrupts(exit));
  }),
);
```

(`worker/http/interrupt-on-abort.unit.test.ts` is the worked example.) `Deferred` is the same
idea when the signal carries a value.

Two scoped exceptions:

- **Negative assertions** ("nothing arrives within the window") cannot await an event that must
  not happen — a bounded timer is the only tool. Know its failure direction: on a slow runner
  it false-PASSES (masks), it never false-fails. Acceptable for liveness checks; never use this
  shape for positive coordination.
- **The oracle/compile harness keeps its `ManagedRuntime.runPromise` conversion point**
  (`packages/fate-effect`'s Executor/oracle suites — `runtime.runPromise` on a harness-owned
  runtime, the runtime-METHOD form; the static `Effect.run*` form is banned from package
  sources by the conversion-point enumeration test): the JS conversion boundary is the
  *subject under test* there, not a style anachronism. Don't "migrate" it to `it.effect`.

Existing plain-vitest tests that run Effects via `runPromise` convert to `it.effect`
opportunistically — when a change next touches the file, not as a churn pass.

## Which tier to write

Apply the litmus — *"could this be wrong even if the database behaved perfectly?"* In practice:

- **`unit` (`*.unit.test.ts`)** — pure helpers (cursor codecs, the keyset *decision* / cursor-miss branch), the wire-code annotation pins (`<feature>/errors.unit.test.ts`), the `livePublisherFor` frame/swallow contract, and a feature service's decisions over a substituted `Drizzle` double (`Vote.unit.test.ts`, the `Drizzle` `run`/`batch` smoke in `Drizzle.unit.test.ts`, re-homed fate-op decisions in `queries.unit.test.ts`). Also the `LiveDO` instance factory over a `DurableObjectState` fake (`do.test.ts`).
- **`integration`** — only what the in-process algebra can't reach faithfully: anything that depends on **real D1 execution** (FTS5 MATCH/bm25 and the write→sync→read loop, collation/NULL/date keyset *execution* tiebreaks, batch atomicity rollback, `meta.changes` idempotency, read-row shaping and aggregate counters), the better-auth session round-trip, and the DO+SSE+D1 composite. Black-box HTTP over the deployed worker — see [alchemy-test-harness.md](./alchemy-test-harness.md).

Don't push a pure-logic or decision-level assertion up to `integration` — that pays remote-D1 flake to test what a substituted `Drizzle` covers offline and faithfully; and don't try to prove a real-D1 fidelity fact (FTS5 folding, collation order) on a substituted seam, where it proves nothing.

## Stubbing a service when you genuinely need to

When a unit test is exercising one layer of logic in isolation — an error-encoding path, a service over a substituted `Drizzle` seam — `Layer.succeed` is the right tool:

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

The full service record is required — `Layer.succeed` is identity on the Tag's value shape. `Layer.succeed` is for a service whose *real* behavior is incidental to what you're testing (the resolver wrapper, an error-encoding path) — or for substituting the `Drizzle` seam *below* the unit under test (the throwing / scripted doubles above). If you find yourself hand-rolling a feature service's *real* DB-dependent behavior in a stub, that's a signal the assertion belongs at the `integration` tier on real D1, not a stub of the thing under test.

## Testing the `Drizzle` service (infrastructure)

`run` and `batch` (the bound methods on the `Drizzle` service value) are the trust boundary. Test them in isolation against a fake/in-memory drizzle setup. See the [feature-services.md](./feature-services.md#the-drizzle-service) testing-scope notes — scope B (smoke + semantics + composition + type inference + error propagation), ~10-15 tests.

Tests build a `Drizzle` layer over a test-supplied `db` via the production factories (`makeDrizzleAccess` / `makeDrizzleLayer` in `worker/db/Drizzle.ts`) — the test layer is exactly the production wiring with a fake `DrizzleDb`, so the `run` / `batch` bodies under test are the ones that ship.

Canonical implementation: `apps/web/worker/db/Drizzle.test.ts`.

## Helpers in test files

- **Service fixtures** — small builder functions that return realistic input shapes. Live at the top of the test file or in a sibling `fixtures.ts`. Pure functions, plain TS, no Effect needed.
- **Seed helpers** — wrap calls to the *real* services. `seedTerm(sozluk, slug, defs)` is an Effect that calls `sozluk.addDefinition` multiple times. Lives next to the test that uses it. (In integration tests the equivalent is the harness's `h.seedTerm(...)` — see [alchemy-test-harness.md](./alchemy-test-harness.md).)
- **Test layer vs. platform fake — the distinction IS the rule.** An Effect **service**'s test seam is a **test layer**: a `Layer.succeed(Service, impl)` (or `Layer.effect`) that provides the service with a test implementation — the layer *is* the seam (see "Stubbing a service" above). The **test-double meaning carries in the layer name**, not a file suffix, following the Effect ecosystem grammar:
  - **`layerTest`** — a working test implementation (effect.website "Managing Layers" documents the `Live`/`Test` suffix, e.g. `DatabaseLive`/`DatabaseTest`; effect-smol v4's layer-tests doc uses a `static readonly layerTest` on the `Context.Service` class; v3 ships module-level `HttpServer.layerTestClient`). Phoenix's [`better-auth.testing.ts`](../apps/web/worker/features/pasaport/better-auth.testing.ts) exports module-level `layerTest(instance)` (the `HttpServer.layerTestClient` form — `BetterAuth` is a third-party tag, not a phoenix `Context.Service`).
  - **`layerStub`** — a canned / **fail-on-contact** double (a stub that returns fixtures or `Effect.die`s if a path it shouldn't reach is hit). `better-auth.testing.ts`'s `layerStub()` cans `getSession` and `Effect.die`s in `fetch` — the fate-op tests provide it because they never touch the session/auth paths.
  - **`layerNoop`** — a double whose methods silently succeed as no-ops (v3's `FileSystem.layerNoop` / `MessageStorage.layerNoop`). Use this *only* when no-op-and-succeed is the wanted behavior — **not** for fail-on-contact (that's `layerStub`).

  For a phoenix `Context.Service` you own, the v4 form is a **`static readonly layerTest` on the service class** — but only if it has a real consumer (no consumer-less layers). Where the test double must return more than the bare seam (e.g. a capture sink), build it with a small factory closure that returns both halves: the fate server provides `LivePublisher` as a per-request VALUE (not a layer), so its recording double wraps [`live-publisher.ts`](../apps/web/worker/features/fate-live/live-publisher.ts)'s `livePublisherFor` over a capturing publish + collecting `waitUntil` — see [`run-fate-op.ts`](../apps/web/worker/features/fate/run-fate-op.ts), which owns the capture array internally and surfaces `published` in its `FateOpResult`.

  **`TestXxx` (prefix) is reserved for the framework kit** (`TestClock`, `TestConsole`) — do **not** use the prefix form for feature services.

  **Never** model a service's test double as a loose fake object or "fake effect" — wrap it in its layer. A standalone **platform fake** is reserved for a non-Effect **platform type** you can't express as a service that a `unit` test genuinely needs — a `DurableObjectState` (the `D1Database` is **not** one of these any more: faking it is banned, ADR 0082, so there is no `node:sqlite` platform fake — DB-touching behavior runs at `integration` on real D1). The surviving platform fake lives in a **colocated `*.testing.ts`** exporting a `makeXxxForTest()` factory ([`worker/features/fate-live/do-state.testing.ts`](../apps/web/worker/features/fate-live/do-state.testing.ts)'s `makeDurableObjectStateForTest()`); the service built *over* the fake is still provided by a test layer. The `.testing.ts` suffix keeps the platform fake out of the vitest `worker/**/*.test.ts` glob while staying type-checked; per-line `// biome-ignore lint/plugin:` justifies any boundary cast inside it. (The `.fake.ts` suffix this convention replaced had zero precedent in the Effect ecosystem; `.testing.ts` + the layer-name grammar above is the idiomatic form.)
- **No `__support__/`, `__tests__/`, `test-utils/`, or top-level `test/` folder** for either — that's layered-folder drift ([[feedback_colocate_over_layered_folders]]); colocate test layers + platform fakes by feature.
- **Don't share mock layers across files** — if two tests need the same service *stub* (a `Layer.succeed(Service, …)`), that's a smell that maybe a fixture or seed helper is the better abstraction. (A platform *fake* — a real in-memory `D1Database`/`DurableObjectState` — is fine to share via a `*.testing.ts`.)

## TestClock and time-dependent tests

For anything time-sensitive (TTL expiry, debouncing, scheduled work), use `TestClock`
from `effect/testing/TestClock` and provide its `TestClock.layer()` (effect-smol/v4 —
there is no `TestContext.TestContext` aggregate to provide; the clock layer alone
virtualizes time):

```ts
import * as TestClock from "effect/testing/TestClock";

it.effect("expires after 1 hour", () =>
  Effect.gen(function*() {
    const result = yield* doSomethingWithTtl;
    yield* TestClock.adjust(Duration.hours(2));
    const expired = yield* checkStatus;
    assert.strictEqual(expired, "expired");
  }).pipe(Effect.provide(TestClock.layer())),
);
```

`Clock.currentTimeMillis` reads the `TestClock` once `TestClock.layer()` is provided,
so TTL math under test is deterministic — see
[`apps/dashboard/worker/features/pipeline/Pipeline.test.ts`](../apps/dashboard/worker/features/pipeline/Pipeline.test.ts)
(the pipeline cache's within-TTL hit / past-TTL refresh).

Never use `setTimeout`, `Date.now()`, or real wall-clock sleeps in tests. `TestClock` virtualizes time; assertions become deterministic.

## Anti-patterns

- **`Effect.runSync(effect)` inside `it(...)`.** Use `it.effect` instead.
- **`expect(...).toBe(...)` inside `it.effect`.** Use `assert.strictEqual` etc.
- **Re-implementing a feature service's *DB-dependent* behavior in a `Layer.succeed` stub.** `Layer.succeed` substitutes the `Drizzle` seam *below* the unit (throwing / scripted doubles) or stubs a service whose behavior is incidental — it is **not** for re-deriving the thing under test. A real-D1 fidelity fact belongs at `integration`, not a stub.
- **Booting a SQL engine and calling it a unit test** (the banned `node:sqlite` / `makeSqliteTestDb` pattern, ADR 0082). If a test needs a database, it is an `integration` test on real D1.
- **Proving a pure-logic or decision-level fact at `integration`.** It belongs in `unit` — offline and flake-free. `integration` pays remote-D1 latency; spend it only on real-D1 fidelity.
- **Setting up a unit-test layer inside `beforeEach`** when it doesn't change between tests. Module-scope it.
- **`setTimeout`/timer ticks as fiber coordination.** Await a `Latch`/`Deferred` the program resolves — see "Fiber coordination" above. Timers are for negative liveness checks only.
- **Snapshot tests against effect-internal shapes** (Causes, Exits) — they include implementation details that change between effect versions. Assert on the success value or the error `_tag`, not the cause structure.

## See also

- [ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md) — the two-tier decision (`unit` / `integration`, the `node:sqlite` ban, the litmus); supersedes [ADR 0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md) (the retired four-tier T0–T3 taxonomy)
- [alchemy-test-harness.md](./alchemy-test-harness.md) — the `integration` path (black-box HTTP against the deployed worker, per-file `Test.make` stages)
- [effect-context-service.md](./effect-context-service.md) — service definition mechanics
- [feature-services.md](./feature-services.md) — the `Drizzle` service contract and its testing scope
- [effect-error-operators.md](./effect-error-operators.md) — `Exit`, `Cause`, `catchTag` used in tests
