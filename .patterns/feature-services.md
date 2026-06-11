# Feature services

Each feature directory in phoenix exposes **one** `Context.Service` — a flat record of domain methods that the resolver layer yields. Reads and writes sit together. The service depends on a `Drizzle` service that holds the singleton drizzle builder.

See also [effect-context-service.md](./effect-context-service.md) for service-definition mechanics, [effect-errors.md](./effect-errors.md) for the error model, and [effect-fn-tracing.md](./effect-fn-tracing.md) for the method shape.

## Why one service per feature

A service is a unit of substitutability, not a DDD aggregate. Don't split a feature into "write repo + read service" — phoenix doesn't have separate stores, separate consistency models, or independent test-doubling needs that would justify the split.

- **One service per feature folder.** `Sozluk`, `Pano`, `Vote`, `Pasaport`.
- Methods are domain-shaped (`addDefinition`, `voteOnPost`, `listPostsConnection`) and live together regardless of read/write direction.
- A shared `Drizzle` service holds the singleton drizzle builder.

## Layered architecture

Three layers, bottom-up:

```
Drizzle           — holds the singleton drizzle(env.PHOENIX_DB, {schema}) builder
  ↑
Sozluk, Pano,     — domain services: feature-shaped methods
Vote, Pasaport
  ↑
fate resolvers /  — orchestrate domain services, shape wire entities (worker/features/fate/)
sources
```

Each layer depends only on the one below it. Resolvers never touch `Drizzle` directly. Domain services never read `Cloudflare.WorkerEnvironment` directly — the bound D1 is threaded in via `Drizzle`, env vars are read at worker scope, not inside features.

## The `Drizzle` service

The Tag's value is a `DrizzleAccess` record carrying two bound methods — `run` (single-statement) and `batch` (atomic multi-statement). The `Drizzle` class itself is identity-only: no statics, no helpers. The only API surface is the destructured methods on the yielded service value.

```ts
// The contract — the Tag's value shape.
export interface DrizzleAccess {
  readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A, DrizzleError>;
  readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
    fn: (db: DrizzleDb) => T,
  ) => Effect.Effect<BatchResult<T>, DrizzleError>;
}
// The `DrizzleError` catch lives in `DrizzleLive`'s body — exactly one place.

// The domain-service view — same methods, `DrizzleError` already a defect.
export interface DrizzleAccessOrDie {
  readonly run: <A>(fn: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A>;
  readonly batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(
    fn: (db: DrizzleDb) => T,
  ) => Effect.Effect<BatchResult<T>>;
}
export const orDieAccess: (access: DrizzleAccess) => DrizzleAccessOrDie;
```

Canonical implementation: `apps/web/worker/db/Drizzle.ts`. Read it once — the shape above is the contract, not the implementation.

Feature code never writes `Effect.tryPromise` directly. Every drizzle call goes through `run` (single statement) or `batch` (atomic multi-statement), destructured off the service value at layer build — through `orDieAccess`, see the boundary rule below. The D1 binding never leaves the `Drizzle` service.

### The boundary rule: infra failures die inside the service

Infra-failure policy is a domain-boundary decision. A feature service destructures `orDieAccess(yield* Drizzle)` at layer build, so every internal DB call site collapses `DrizzleError` into the defect channel — and the service's **public method signatures carry domain errors only** (`Effect<TermPage | null>`, not `Effect<TermPage | null, DrizzleError>`). The fate layer (sources/queries/lists/mutations) consequently never imports or names Drizzle: there is nothing to `orDie` at the transport edge.

Why here and not at the call sites: the typed `DrizzleError` channel had **zero typeful consumers** — nothing caught, retried, or matched it; every one of ~64 fate-handler call sites uniformly piped `orDieDrizzle`, which meant the transport layer named the persistence tech everywhere while exercising a single policy that belongs to the domain.

The trade-off, recorded: callers lose the *option* of typeful infra handling (e.g. a typed retry on `DrizzleError`) — an option nothing used. If a future caller genuinely needs to observe infra failures, defects remain reachable (`Effect.sandbox` / `Effect.catchAllDefect`), or that one method can reintroduce a typed infra error deliberately. The die happens per `run`/`batch` call (the Drizzle call sites), not as a blanket wrap around whole methods — future domain errors keep flowing through method bodies untouched.

`worker/features/domain-error-boundary.unit.test.ts` pins the rule per service: a type-level sweep proves no method's `E` contains `DrizzleError`, plus one exact-domain-union pin per service.

### Why `run` / `batch` are NOT statics on the Tag class

An earlier shape (pre-fbb57d8) put `run` / `batch` as `static readonly` effects on the Tag class — they yielded `Drizzle` internally and wrapped the promise. That looked clean but every method that yielded `Drizzle.run(...)` carried `Drizzle` in its inferred `R` channel, so every service method ended up as `Effect<A, E, Drizzle>` and the dep bled into resolvers and tests. To paper over that, services wrote closure-captured `tryDb` wrappers that re-yielded `Drizzle` once at layer build and then used a captured `db` directly — three parallel APIs (`Drizzle.run` static, `tryDb` closure, raw `Effect.tryPromise` inside batch) all doing the same job.

The current shape (`run` / `batch` as bound methods on the Tag value, destructured at layer build) keeps method types as `R = never` with one canonical API and no wrapper closures. The destructure is the natural place to capture the dep — same code as the old `tryDb` would have produced, just lifted into the foundation.

The service earns its keep by:

- Constructing the drizzle builder once per request.
- Giving feature services one uniform call pattern for all drizzle operations.
- Centralizing the promise → Effect boundary so feature code is fully Effect-native.
- Being trivially swappable for tests that want an in-memory drizzle.

### House rule: `Effect.tryPromise` always uses object notation

Object notation forces an explicit `catch` at every async boundary. The single-arg form (`Effect.tryPromise(() => p)`) falls back to a generic `UnknownError` — no useful tag, no per-site error semantics. Inside `Drizzle.run` and `Drizzle.batch`, the catch produces a tagged `DrizzleError` so the resolver layer can map it to `INTERNAL_SERVER_ERROR` cleanly. Anywhere else in the codebase that wraps a promise: same rule, explicit `catch` with a tagged error.

### Single-query reads/writes

```ts
const {run} = orDieAccess(yield* Drizzle);  // at layer build, once

const term = yield* run((db) =>
  db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
);

const inserted = yield* run((db) =>
  db.insert(schema.definitionView).values({/* ... */}).returning(),
);
```

The callback receives the typed drizzle builder. The Effect's success type is inferred from the callback's return type. Infra failures die right here (the boundary rule above), so `E` stays whatever the method's domain logic raises. Method `R` channels stay `never` because `Drizzle` was already yielded at layer build.

### Atomic batch

```ts
const {batch} = orDieAccess(yield* Drizzle);

yield* batch((db) => [
  db.insert(schema.definitionVote).values({/* ... */}),
  db.update(schema.definitionView).set({score: sql`score + 1`}).where(eq(schema.definitionView.id, id)),
  db.insert(schema.userVote).values({/* ... */}),
] as const);
```

The callback returns the tuple of unexecuted drizzle statements. Drizzle's `db.batch([...])` runs them atomically via D1's native batch API. The result is typed against the tuple — `batch` returns `BatchResult<T>` (which is drizzle's `BatchResponse<T>`).

### Raw SQL escape hatch

When you need a SQL statement drizzle's builder doesn't model cleanly (e.g. multi-row `INSERT … ON CONFLICT DO UPDATE`, `DELETE FROM x WHERE id IN (subquery)`), route it through `run((db) => db.run(sql\`…\`))` rather than reaching for `env.PHOENIX_DB.prepare(...)`. Every db touch must flow through the Drizzle service — `apps/web/worker/db/Drizzle.ts` is the only file that legitimately reads `env.PHOENIX_DB` (to build the drizzle builder once).

## A feature service

```ts
// worker/features/sozluk/Sozluk.ts
import {and, asc, desc, eq, isNull} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {id} from "@usirin/forge";
import * as schema from "../../db/drizzle/schema";
import {Drizzle} from "../../db/Drizzle";
import {
  BodyRequired,
  BodyTooLong,
  DefinitionNotFound,
  UnauthorizedDefinitionMutation,
} from "./errors";

export class Sozluk extends Context.Service<
  Sozluk,
  {
    // reads — infra failures are defects, so a pure read has NO error channel
    readonly getTerm: (
      slug: string,
    ) => Effect.Effect<TermPage | null>;

    readonly listDefinitionsConnection: (
      slug: string,
      opts: {first?: number; after?: string | null},
    ) => Effect.Effect<DefinitionConnectionPage>;

    readonly listTermSummaries: (
      opts: {sort?: "recent" | "popular"; limit?: number},
    ) => Effect.Effect<ReadonlyArray<TermSummaryRow>>;

    // writes — domain errors only
    readonly addDefinition: (
      input: AddDefinitionInput,
    ) => Effect.Effect<AddDefinitionResult, BodyRequired | BodyTooLong>;

    readonly editDefinition: (
      input: EditDefinitionInput,
    ) => Effect.Effect<
      EditDefinitionResult,
      BodyRequired | BodyTooLong | DefinitionNotFound | UnauthorizedDefinitionMutation
    >;

    readonly deleteDefinition: (
      input: DeleteDefinitionInput,
    ) => Effect.Effect<
      DeleteDefinitionResult,
      DefinitionNotFound | UnauthorizedDefinitionMutation
    >;

    readonly voteDefinition: (
      input: VoteDefinitionInput,
    ) => Effect.Effect<VoteDefinitionResult, DefinitionNotFound>;
  }
>()("@phoenix/sozluk/Sozluk") {}
```

### Rules

- **One service per feature folder.** Even if the feature has 20 methods. Splitting buys nothing if the methods share a layer dep and a domain.
- **Reads and writes sit together.** Read methods (`listTermSummaries`) live alongside mutation methods (`addDefinition`). They share the same drizzle builder, schema, error type, and tests.
- **Method names are domain-shaped.** `addDefinition`, not `insertDefinitionRow`. The service is the domain layer.
- **Errors in the `E` channel, tagged — and DOMAIN errors only.** Per-method error unions are explicit in the type; infra failures (`DrizzleError`) die inside the service (the boundary rule above) and never appear in a public signature. The resolver pattern-matches on `_tag` to map to wire codes. See [effect-errors.md](./effect-errors.md).
- **No `env` or `D1Database` in method signatures.** The `Drizzle` dep is captured at layer-build time.

### The live layer

```ts
export const SozlukLive = Layer.effect(Sozluk)(
  Effect.gen(function*() {
    // ----- Yield deps once at layer build -----
    const {run, batch} = orDieAccess(yield* Drizzle); // infra failures die here; R = never in callers
    const vote = yield* Vote;                         // cross-service dep, see below

    // ----- Helpers: private closures, intermediate consts -----

    const validateBody = (raw: string) => {
      if (raw.trim().length === 0) return new BodyRequired();
      if (raw.length > DEFINITION_BODY_MAX) return new BodyTooLong({max: DEFINITION_BODY_MAX});
      return Effect.succeed(raw);
    };

    const recomputeTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(
      function*(slug: string, title: string, now: Date) {
        // ... aggregate recompute body — uses `run` / `batch` directly
      },
    );

    // ----- Service methods: inline in the returned record -----

    return {
      getTerm: Effect.fn("Sozluk.getTerm")(function*(slug: string) {
        const meta = yield* run((db) =>
          db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
        );
        if (!meta) return null;
        // ... rest
      }),

      addDefinition: Effect.fn("Sozluk.addDefinition")(function*(input: AddDefinitionInput) {
        const body = yield* validateBody(input.body);
        const definitionId = id("def");
        const now = new Date();

        yield* run((db) =>
          db.insert(schema.definitionView).values({id: definitionId, /* ... */}),
        );
        yield* recomputeTermSummary(input.termSlug, input.title ?? input.termSlug, now);

        return {definitionId, /* ... */};
      }),

      // ... listDefinitionsConnection, editDefinition, deleteDefinition, voteDefinition
    };
  }),
);
```

Notes:

- **Each method is `Effect.fn("Sozluk.method")(function*(args) {...})` inline in the returned record.** No intermediate const, no `Sozluk["method"]` index annotation. `Layer.effect(Sozluk)(gen)` already constrains the returned shape — annotations are redundant and TS error messages point at the wrong place when a method is mistyped.
- **Helpers are intermediate `const`s above the return.** Closures over yielded services like `vote`. They're private. They become methods on the service only if a resolver needs to call them directly.
- **Each method gets a named span automatically via `Effect.fn`.** See [effect-fn-tracing.md](./effect-fn-tracing.md) for naming conventions and when to use `fnUntraced` instead.
- **Validation is part of the method, not a separate concern.** `validateBody` returns either a tagged error or the cleaned body. The method's `E` channel surfaces what can fail.

## Handler call sites

Fate handlers live per-feature (`worker/features/<feature>/mutations.ts`, `queries.ts`, `lists.ts`); each is a thin orchestration over a service, authored as a `Fate.query`/`Fate.list`/`Fate.mutation` entry — a pure-data definition paired with an `Effect.fn("<wire name>")` handler, run by the native interpreter on the request fiber (the per-request `CurrentUser`/`LivePublisher` provided onto each effect as values off the request context — ADR 0043, [fate-effect-operations.md](./fate-effect-operations.md)). The `worker/features/fate/{mutations,queries,lists,shapers,sources,views}.ts` files are barrels that compose each feature's piece into the maps fate expects:

```ts
// worker/features/sozluk/mutations.ts
"definition.add": Fate.mutation(
  {input: AddDefinitionInput, type: DefinitionView, error: Schema.Union([Unauthorized, BodyRequired, BodyTooLong])},
  Effect.fn("definition.add")(function* ({input}) {
    const user = yield* CurrentUser.required;
    const sozluk = yield* Sozluk;
    return yield* sozluk.addDefinition({...input, authorId: user.id});
  }),
),
```

Read handlers look the same (`Fate.query`):

```ts
term: Fate.query(
  {args: {slug: Schema.String}, type: TermView},
  Effect.fn("term")(function* ({args}) {
    const sozluk = yield* Sozluk;
    return yield* sozluk.getTerm(args.slug, {first: 50});
  }),
),
```

The interpreter's dispatch ([fate-effect-interpreter.md](./fate-effect-interpreter.md)) handles `Effect.Exit` (the oracle-baseline compile step maps exits the same way). Tagged errors in the handler's declared `error` union flow through `encodeWireError` (the `WireCode` annotation) to wire codes.

## Cross-feature dependencies

Vote logic is shared by `Sozluk.voteDefinition` and `Pano.voteOnPost`. `Vote` is its own `Context.Service` — not a module of helper functions.

```ts
export const SozlukLive = Layer.effect(Sozluk)(
  Effect.gen(function*() {
    const {run} = yield* Drizzle;
    const vote = yield* Vote;

    return {
      voteDefinition: Effect.fn("Sozluk.voteDefinition")(function*(input) {
        const result = yield* vote.cast({...});  // method R picks up Vote here
        // recompute term aggregates via run((db) => ...)
        return {/* ... */};
      }),
      // ...
    };
  }),
);
```

The dep graph: `Pano → Vote → Drizzle`, `Sozluk → Vote → Drizzle`. Vote's own deps (karma rules, rate limits, audit when those land) stay encapsulated — consumers don't see them.

### Shared service → feature dependency: invert it

A shared low-level service (Vote sits below the feature directories — Sozluk AND Pano consume it) must not import FROM a feature directory. When Vote needs something a feature owns — the karma counter lives in pasaport's `user_profile` — Vote declares a contract IT owns and the feature provides the implementation at composition:

```ts
// vote/Vote.ts — the contract, owned by Vote (names only db primitives)
export interface KarmaBumpService {
  readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
}
export class KarmaBump extends Context.Service<KarmaBump, KarmaBumpService>()(
  "@phoenix/vote/KarmaBump",
) {}

// fate/layers.ts — the composition root provides pasaport's implementation
const KarmaBumpFromPasaport = Layer.succeed(KarmaBump, {statement: karmaBumpStatement});
```

`VoteLive` yields `KarmaBump` at layer build and batches the provided statement atomically with the vote insert / score update — the batching is identical, Vote just stops knowing where the statement comes from. The `vote/ → pasaport/` arrow exists only at the composition seam (`fate/layers.ts`), and the contract is künye's swap point: a DO-backed karma bump replaces the provided value there without touching Vote. Pinned in `vote-boundary.unit.test.ts` (an import sweep over `vote/` + exact type pins on `VoteLive`'s `R` and the contract's surface). Tests that build `VoteLive` directly provide their own `KarmaBump` (see `Vote.test.ts`); tests composing through `makeFateLayer`/`PhoenixFateLive` get the production provision for free.

Vote-delegating methods are the one place a method's `R` widens beyond `never`: `voteDefinition` / `retractDefinitionVote` infer as `Effect<A, E, Vote>` because they call `yield* vote.cast(...)`. That's correct — the dep is real. The Drizzle dep is satisfied by the destructured `run` and stays out of `R`.

## Wiring at the worker entry

See `apps/web/worker/features/fate/layers.ts` (the `makeFateLayer` factory) for the canonical composition. The shape, summarized:

`Layer.provide` is the composition mechanism: feature services + `Drizzle` get satisfied at worker scope (alchemy provides `Cloudflare.WorkerEnvironment` and the bound D1); the per-request pair (`CurrentUser`/`LivePublisher`) is provided onto each operation by the interpreter, never at layer scope. Because `Sozluk` and `Pano` both depend on `Vote`, the runtime uses `Layer.provideMerge(VoteLive)` over their merged slice so `Vote` is shared and stays visible in the resulting layer's output — with Vote's own `KarmaBump` contract discharged right there via `Layer.provide(KarmaBumpFromPasaport)` (plain `provide`: the contract is Vote's internal seam, not a worker service routes see). The final layer has no remaining `R`, so it's runnable. See [effect-layer-composition.md](./effect-layer-composition.md#the-worker-layer-set) for why this shape avoids the `Layer.mergeAll` dependency warning.

## Testing

Two strategies, picked per test:

**Unit tests — swap the service:**

```ts
const TestSozluk = Layer.succeed(Sozluk, {
  getTerm: () => Effect.succeed(fixtures.termPage()),
  addDefinition: (input) =>
    input.body.trim() === "" ? new BodyRequired() : Effect.succeed(fixtures.added()),
  // ... full record
});

it.effect("rejects empty body via resolver", () =>
  someResolverEffect.pipe(Effect.provide(TestSozluk)),
);
```

**Integration tests — keep the live layers, build over a real D1:**

```ts
const db = createDrizzle(sqlite.d1);
const TestLive = makeFateLayer(db, fakeAuthInstance);
```

Integration tests in `tests/integration/*.test.ts` use the second form — same `makeFateLayer` factory the worker init calls, just over a node-`sqlite`-backed D1 stand-in.

## See also

- [effect-context-service.md](./effect-context-service.md) — class-form services, layer shapes
- [effect-layer-composition.md](./effect-layer-composition.md) — runtime wiring, the worker layer set
- [effect-errors.md](./effect-errors.md) — tagged error patterns
- [effect-error-operators.md](./effect-error-operators.md) — catching and inspecting failures
- [effect-fn-tracing.md](./effect-fn-tracing.md) — `Effect.fn` vs `Effect.fnUntraced` for method shape
- [effect-testing.md](./effect-testing.md) — integration via miniflare + the live runtime
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema` for trust-boundary input validation
- `packages/fate-effect/src/CurrentUser.ts` — canonical small-service example with a static helper
