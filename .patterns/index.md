# Phoenix patterns

Reusable patterns for writing phoenix code — the backend and the frontend's data layer. These are **evergreen** — they describe how the codebase is structured, not how to migrate to it. Treat them as the load-bearing references when adding features, fixing bugs, or onboarding a new agent.

Start with [effect-context-service.md](./effect-context-service.md) and [feature-services.md](./feature-services.md). The rest fill in.

## Three layers

- **Effect domain layer** (the `effect-*` docs) — services, errors, layer composition, tracing, testing, validation. Transport-agnostic: domain logic lives here and knows nothing about how data reaches the client.
- **fate protocol layer** (the server-side `fate-*` docs) — how the backend serves data. Data views are the schema, an Effect bridge runs domain services through the request runtime, and hand-built sources back each view. Served by [fate](https://github.com/usirin/fate)'s native protocol via `createFateServer` mounted on Hono (no tRPC/GraphQL adapter).
- **fate client layer** (the client-side `fate-*` docs) — how the SPA consumes data. Components declare views, one batched `useRequest` per screen, declarative mutations, and live views over SSE. Built on `react-fate`.

The protocol and client layers share one view/type model: the server's `Entity<>` types are the client's types, generated, with no schema artifact between them. The bridge ([fate-effect-bridge.md](./fate-effect-bridge.md)) is the seam between the domain and protocol layers — read it first when working server-side.

## Index — Effect domain layer

| Doc | Topic | Read when |
|---|---|---|
| [effect-context-service.md](./effect-context-service.md) | Class-form services, layer shapes, `return yield*`, service-method shape | Defining a new service or layer |
| [feature-services.md](./feature-services.md) | One service per feature folder, `Drizzle` capability service, `Drizzle.run`/`Drizzle.batch` callbacks | Adding a feature service, writing service methods |
| [effect-layer-composition.md](./effect-layer-composition.md) | `Layer.mergeAll` / `Layer.provide` / `ManagedRuntime`, the request + admin two-runtime story | Wiring services into a runtime, adding a new runtime |
| [effect-errors.md](./effect-errors.md) | `Data.TaggedError` modeling, domain vs infra split, `_tag` → wire-code mapping | Designing a new error or feature's error set |
| [effect-error-operators.md](./effect-error-operators.md) | `Effect.catchTag`/`Tags`/`All`, `Effect.exit`, `Cause`/`Exit` inspection | Catching, recovering, or inspecting failures at a boundary |
| [effect-fn-tracing.md](./effect-fn-tracing.md) | `Effect.fn` for service methods, span naming conventions | Writing or naming a service method |
| [effect-testing.md](./effect-testing.md) | `@effect/vitest`, `it.effect`, integration tests via miniflare, when to use unit tests | Writing tests for features or infrastructure |
| [effect-schema-validation.md](./effect-schema-validation.md) | `Schema.Class` for trust-boundary input validation | Validating untyped input (resolver inputs, Hono bodies, external APIs) |

## Index — fate protocol layer

Read [fate-effect-bridge.md](./fate-effect-bridge.md) first — it's the seam everything else hangs off.

| Doc | Topic | Read when |
|---|---|---|
| [fate-effect-bridge.md](./fate-effect-bridge.md) | `fateQuery`/`fateList`/`fateMutation`/`fateSource`, `FateContext` carrying the runtime, `encodeFateError` | The seam between fate and Effect — read first |
| [fate-data-views.md](./fate-data-views.md) | `dataView`/`Entity`/`computed`/`count`/`list`, selection masking, modeling conventions, raw IDs | Declaring an entity type |
| [fate-sources.md](./fate-sources.md) | Hand-built `SourceResolver`, Effect-backed `byId`/`byIds`/`connection` executors, never the Drizzle adapter | Wiring a view's reads to a service |
| [fate-mutations.md](./fate-mutations.md) | `mutations` map, validation in services, re-resolving the changed entity, delete returns the parent | Writing a mutation |
| [fate-connections.md](./fate-connections.md) | `ConnectionResult`, custom `lists` resolvers vs source `connection`, cursor ownership | Writing a paginated list |
| [fate-server-wiring.md](./fate-server-wiring.md) | `createFateServer` composition, per-request runtime owned by the Hono route, codegen | Assembling/mounting the server |

## Index — fate client layer

Read [fate-client-setup.md](./fate-client-setup.md) first, then [fate-views-and-requests.md](./fate-views-and-requests.md).

| Doc | Topic | Read when |
|---|---|---|
| [fate-client-setup.md](./fate-client-setup.md) | `createFateClient`, `<FateClient>` provider, auth, generated client, Suspense/error rails | Wiring the client / app shell |
| [fate-views-and-requests.md](./fate-views-and-requests.md) | `view`/`useView`/`ViewRef`, masking, one batched `useRequest` per screen, `useListView` pagination | Reading data in a component |
| [fate-mutations-client.md](./fate-mutations-client.md) | `fate.mutations`/`actions`, optimistic updates, `insert`/`delete` membership, error routing | Writing data from the UI |
| [fate-live-views.md](./fate-live-views.md) | `useLiveView`/`useLiveListView`, server `live.*` publishing, the SSE wire, the `LiveDO` Durable Object | Making a view live (spans client + server) |

## fate protocol conventions

- **fate is pure transport; Effect services are the domain.** Reads and writes go through service methods — fate never queries the database, and `createDrizzleSourceAdapter` is never used.
- **No `runtime.runPromise*` outside the bridge.** Resolvers and source executors are Effect generators wrapped by `fateQuery`/`fateList`/`fateMutation`/`fateSource`.
- **Validation lives in services** (ADR 0013). fate's `input` schema is thin shape-coercion only.
- **The server is the single source of truth for types.** The client imports `Entity<>` types; codegen emits the client wiring. No schema artifact.
- **One batched request per screen.** A screen root declares its whole view tree in one `useRequest`; child `useView` calls read from cache — no waterfalls. Mutations are declarative (`optimistic`, `insert`/`delete`); no imperative cache updaters.
- **Live views run over SSE through the `LiveDO` Durable Object.** The built-in in-memory bus can't fan out across Worker isolates, so a publish-only `LiveEventBus` forwards events to `LiveDO`, which owns the SSE connections and fans out. `LiveDO` is the one Durable Object in phoenix.

## Conventions across these docs

- **All patterns are effect v4** (`effect@4.0.0-beta.*`). Earlier `@effect/sql-drizzle`-style examples don't apply directly.
- **Drizzle is the query builder.** Wrapped behind `Drizzle.run` / `Drizzle.batch` callbacks — feature code never writes `Effect.tryPromise` directly.
- **House rule: `Effect.tryPromise` always uses object notation** with an explicit `catch` producing a tagged error. The single-arg form is treated like `Effect.promise`.
- **Service methods always use `Effect.fn("Service.method")(function*(args) {...})`** — automatic spans, automatic stack frames. Reserve `Effect.fnUntraced` for genuinely hot internal helpers.
- **One service per feature folder.** Reads + writes coexist. Admin operations get a parallel `<Feature>Admin` service.
- **Testing strategy:** product code → integration tests via miniflare + live layers. Infrastructure (the `Drizzle` service, resolver wrapper, runtime wiring) → isolation tests.

## When to add a new pattern doc here

Add a doc when:

- A pattern is used in **2+ places** and future agents will need to know it.
- The pattern is **non-obvious from reading the codebase** — it codifies a design choice rather than describing existing structure.
- A future agent would otherwise **invent a worse version** if they didn't know about it.

Don't add a doc for:

- One-off implementation details.
- Things that are obvious from reading the code.
- Migration steps (those go in vault grill/RFC artifacts, not here).
