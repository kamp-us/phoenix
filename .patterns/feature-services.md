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
Resolvers         — orchestrate domain services, return GraphQL shapes
```

Each layer depends only on the one below it. Resolvers never touch `Drizzle` directly. Domain services never touch `CloudflareEnv` directly.

## The `Drizzle` service

```ts
// worker/services/Drizzle.ts
import {drizzle} from "drizzle-orm/d1";
import type {BatchItem, BatchResponse} from "drizzle-orm/batch";
import {Context, Data, Effect, Layer} from "effect";
import * as schema from "../db/drizzle/schema";
import {CloudflareEnv} from "./CloudflareEnv";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export class DrizzleError extends Data.TaggedError("@phoenix/Drizzle/Error")<{
  readonly cause: unknown;
}> {}

export class Drizzle extends Context.Service<Drizzle, DrizzleDb>()("@phoenix/Drizzle") {
  /**
   * Run a single drizzle query. The callback receives the drizzle builder and
   * returns the query's Promise; the static yields the service internally and
   * wraps the promise as `Effect<A, DrizzleError>`.
   */
  static readonly run = <A>(fn: (db: DrizzleDb) => Promise<A>) =>
    Effect.gen(function*() {
      const db = yield* Drizzle;
      return yield* Effect.tryPromise({
        try: () => fn(db),
        catch: (cause) => new DrizzleError({cause}),
      });
    });

  /**
   * Atomic multi-statement write. Callback returns the tuple of drizzle
   * statements to batch.
   */
  static readonly batch = <
    U extends BatchItem<"sqlite">,
    T extends Readonly<[U, ...U[]]>,
  >(fn: (db: DrizzleDb) => T) =>
    Effect.gen(function*() {
      const db = yield* Drizzle;
      const statements = fn(db);
      return yield* Effect.tryPromise({
        try: () => db.batch(statements),
        catch: (cause) => new DrizzleError({cause}),
      });
    });
}

export const DrizzleLive = Layer.effect(Drizzle)(
  Effect.gen(function*() {
    const env = yield* CloudflareEnv;
    return drizzle(env.PHOENIX_DB, {schema});
  }),
);
```

Feature code never writes `Effect.tryPromise` directly. Every drizzle call goes through `Drizzle.run` (single statement) or `Drizzle.batch` (atomic multi-statement). The D1 binding never leaves the `Drizzle` service.

The service earns its keep by:

- Constructing the drizzle builder once per request.
- Giving feature services one uniform call pattern for all drizzle operations.
- Centralizing the promise → Effect boundary so feature code is fully Effect-native.
- Being trivially swappable for tests that want an in-memory drizzle.

### House rule: `Effect.tryPromise` always uses object notation

Object notation forces an explicit `catch` at every async boundary. The single-arg form (`Effect.tryPromise(() => p)`) falls back to a generic `UnknownError` — no useful tag, no per-site error semantics. Inside `Drizzle.run` and `Drizzle.batch`, the catch produces a tagged `DrizzleError` so the resolver layer can map it to `INTERNAL_ERROR` cleanly. Anywhere else in the codebase that wraps a promise: same rule, explicit `catch` with a tagged error.

### Single-query reads/writes

```ts
const term = yield* Drizzle.run((db) =>
  db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
);

const inserted = yield* Drizzle.run((db) =>
  db.insert(schema.definitionView).values({/* ... */}).returning(),
);
```

The callback receives the typed drizzle builder. The Effect's success type is inferred from the callback's return type. Errors flow as `DrizzleError`.

### Atomic batch

```ts
yield* Drizzle.batch((db) => [
  db.insert(schema.definitionVote).values({/* ... */}),
  db.update(schema.definitionView).set({score: sql`score + 1`}).where(eq(schema.definitionView.id, id)),
  db.insert(schema.userVote).values({/* ... */}),
]);
```

The callback returns the tuple of unexecuted drizzle statements. Drizzle's `db.batch([...])` runs them atomically via D1's native batch API. The result is typed against the tuple — `Drizzle.batch` returns `BatchResponse<T>`.

## A feature service

```ts
// worker/features/sozluk/Sozluk.ts
import {and, asc, desc, eq, isNull} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {id} from "@usirin/forge";
import * as schema from "../../db/drizzle/schema";
import {Drizzle} from "../../services/Drizzle";
import {
  BodyRequired,
  BodyTooLong,
  DefinitionNotFound,
  UnauthorizedDefinitionMutation,
} from "./errors";

export class Sozluk extends Context.Service<
  Sozluk,
  {
    // reads
    readonly getTerm: (
      slug: string,
    ) => Effect.Effect<TermPage | null, DrizzleError>;

    readonly listDefinitionsConnection: (
      slug: string,
      opts: {first?: number; after?: string | null},
    ) => Effect.Effect<DefinitionConnectionPage, DrizzleError>;

    readonly listTermSummaries: (
      opts: {sort?: "recent" | "popular"; limit?: number},
    ) => Effect.Effect<ReadonlyArray<TermSummaryRow>, DrizzleError>;

    // writes
    readonly addDefinition: (
      input: AddDefinitionInput,
    ) => Effect.Effect<AddDefinitionResult, BodyRequired | BodyTooLong | DrizzleError>;

    readonly editDefinition: (
      input: EditDefinitionInput,
    ) => Effect.Effect<
      EditDefinitionResult,
      BodyRequired | BodyTooLong | DefinitionNotFound | UnauthorizedDefinitionMutation | DrizzleError
    >;

    readonly deleteDefinition: (
      input: DeleteDefinitionInput,
    ) => Effect.Effect<
      DeleteDefinitionResult,
      DefinitionNotFound | UnauthorizedDefinitionMutation | DrizzleError
    >;

    readonly voteDefinition: (
      input: VoteDefinitionInput,
    ) => Effect.Effect<
      VoteDefinitionResult,
      DefinitionNotFound | DrizzleError
    >;
  }
>()("@phoenix/sozluk/Sozluk") {}
```

### Rules

- **One service per feature folder.** Even if the feature has 20 methods. Splitting buys nothing if the methods share a layer dep and a domain.
- **Reads and writes sit together.** Field-resolver reads (`listTermSummaries`) live alongside mutation methods (`addDefinition`). They share the same drizzle builder, schema, error type, and tests.
- **Method names are domain-shaped.** `addDefinition`, not `insertDefinitionRow`. The service is the domain layer.
- **Errors in the `E` channel, tagged.** Per-method error unions are explicit in the type. The resolver pattern-matches on `_tag` to map to wire codes. See [effect-errors.md](./effect-errors.md).
- **No `env` or `D1Database` in method signatures.** The `Drizzle` dep is captured at layer-build time.

### The live layer

```ts
export const SozlukLive = Layer.effect(Sozluk)(
  Effect.gen(function*() {
    // ----- Helpers: private closures, intermediate consts -----

    const validateBody = (raw: string) => {
      if (raw.trim().length === 0) return new BodyRequired();
      if (raw.length > DEFINITION_BODY_MAX) return new BodyTooLong({max: DEFINITION_BODY_MAX});
      return Effect.succeed(raw);
    };

    const recomputeTermSummary = Effect.fn("Sozluk.recomputeTermSummary")(
      function*(slug: string, title: string, now: Date) {
        // ... aggregate recompute body
      },
    );

    // ----- Service methods: inline in the returned record -----

    return {
      getTerm: Effect.fn("Sozluk.getTerm")(function*(slug: string) {
        const meta = yield* Drizzle.run((db) =>
          db.query.termSummary.findFirst({where: eq(schema.termSummary.slug, slug)}),
        );
        if (!meta) return null;
        // ... rest
      }),

      addDefinition: Effect.fn("Sozluk.addDefinition")(function*(input: AddDefinitionInput) {
        const body = yield* validateBody(input.body);
        const definitionId = id("def");
        const now = new Date();

        yield* Drizzle.run((db) =>
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

## Resolver call sites

```ts
// inside a GraphQL resolver
import {Sozluk} from "../features/sozluk/Sozluk";

resolve: resolver(function*(_source, args: {input: AddDefinitionInput}) {
  const {user} = yield* Auth.required;
  const sozluk = yield* Sozluk;
  return yield* sozluk.addDefinition({...args.input, authorId: user.id});
}),
```

Field-resolver reads look the same:

```ts
resolve: resolver(function*(parent: {slug: string}) {
  const sozluk = yield* Sozluk;
  return yield* sozluk.listDefinitionsConnection(parent.slug, {first: 50});
}),
```

The resolver wrapper (`worker/graphql/resolver.ts`) handles `Effect.Exit`. Tagged errors in the service's `E` channel flow through `encodeMutationError` to wire codes.

## Cross-feature dependencies

Vote logic is shared by `Sozluk.voteDefinition` and `Pano.voteOnPost`. `Vote` is its own `Context.Service` — not a module of helper functions.

```ts
export const SozlukLive = Layer.effect(Sozluk)(
  Effect.gen(function*() {
    const vote = yield* Vote;

    return {
      voteDefinition: Effect.fn("Sozluk.voteDefinition")(function*(input) {
        const result = yield* vote.cast({...});
        // recompute term aggregates
        return {/* ... */};
      }),
      // ...
    };
  }),
);
```

The dep graph: `Pano → Vote → Drizzle`, `Sozluk → Vote → Drizzle`. Vote's own deps (karma rules, rate limits, audit when those land) stay encapsulated — consumers don't see them.

## Wiring at the worker entry

```ts
// worker/graphql/runtime.ts
const RequestValues = Layer.mergeAll(
  Layer.succeed(CloudflareEnv, env),
  Layer.succeed(RequestContext, {/* ... */}),
  Layer.succeed(Auth, {/* ... */}),
);

const DataPlane = Layer.mergeAll(SozlukLive, PanoLive, VoteLive, PasaportLive, DrizzleLive).pipe(
  Layer.provide(RequestValues),
);

const runtime = ManagedRuntime.make(Layer.mergeAll(DataPlane, RequestValues));
```

`Layer.provide` is the composition: feature services + `Drizzle` get satisfied by `RequestValues` in one step; merging `RequestValues` back in at the top re-exposes `Auth` / `CloudflareEnv` / `RequestContext` so resolvers can `yield* Auth` directly. The result has no remaining `R`, so the runtime is runnable. See [effect-layer-composition.md](./effect-layer-composition.md#multiple-runtimes--graphql--admin) for why this shape avoids the `Layer.mergeAll` dependency warning.

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

**Integration tests — keep the live layers, swap the env:**

```ts
const TestLive = SozlukLive.pipe(
  Layer.provide(DrizzleLive),
  Layer.provide(Layer.succeed(CloudflareEnv, miniflareEnv)),
);
```

Integration tests in `tests/integration/*.test.ts` use the second form — same miniflare D1, provided through the layer pipeline.

## See also

- [effect-context-service.md](./effect-context-service.md) — class-form services, layer shapes
- [effect-layer-composition.md](./effect-layer-composition.md) — runtime wiring, multi-runtime (graphql + admin)
- [effect-errors.md](./effect-errors.md) — tagged error patterns
- [effect-error-operators.md](./effect-error-operators.md) — catching and inspecting failures
- [effect-fn-tracing.md](./effect-fn-tracing.md) — `Effect.fn` vs `Effect.fnUntraced` for method shape
- [effect-testing.md](./effect-testing.md) — integration via miniflare + the live runtime
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema` for trust-boundary input validation
- `worker/services/Auth.ts` — canonical small-service example with a static helper
