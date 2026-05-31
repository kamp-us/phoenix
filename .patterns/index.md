# Phoenix patterns

Reusable patterns for writing phoenix code — the backend and the frontend's data layer. The `effect-*`, `fate-*`, and `alchemy-*` docs are **evergreen** — they describe how the codebase is structured, not how to migrate to it. Treat them as the load-bearing references when adding features, fixing bugs, or onboarding a new agent. The `alchemy-*` docs describe the infra layer: phoenix runs on [alchemy-effect](https://github.com/usirin/alchemy-effect) — one Effect program for infra + runtime, replacing the old `wrangler.jsonc`, the Hono entry, manual binding access, and the hand-written DO classes.

Start with [effect-context-service.md](./effect-context-service.md) and [feature-services.md](./feature-services.md). The rest fill in.

## Three layers

- **Effect domain layer** (the `effect-*` docs) — services, errors, layer composition, tracing, testing, validation. Transport-agnostic: domain logic lives here and knows nothing about how data reaches the client.
- **fate protocol layer** (the server-side `fate-*` docs) — how the backend serves data. Data views are the schema, an Effect bridge runs domain services through the captured worker service map, and hand-built sources back each view. Served by [fate](https://github.com/usirin/fate)'s native protocol via `createFateServer` mounted on an imperative `HttpRouter.add` route (no tRPC/GraphQL adapter; no Hono).
- **fate client layer** (the client-side `fate-*` docs) — how the SPA consumes data. Components declare views, one batched `useRequest` per screen, declarative mutations, and live views over SSE. Built on `react-fate`.

The protocol and client layers share one view/type model: the server's `Entity<>` types are the client's types, generated, with no schema artifact between them. The bridge ([fate-effect-bridge.md](./fate-effect-bridge.md)) is the seam between the domain and protocol layers — read it first when working server-side.

## Index — Effect domain layer

| Doc | Topic | Read when |
|---|---|---|
| [effect-context-service.md](./effect-context-service.md) | **Effect v4 `Context.Service` (NOT v3 `Context.Tag`)**, class-form services, layer shapes, `return yield*`, service-method shape | Defining a new service or layer |
| [feature-services.md](./feature-services.md) | One service per feature folder, `Drizzle` capability service, `Drizzle.run`/`Drizzle.batch` callbacks | Adding a feature service, writing service methods |
| [effect-layer-composition.md](./effect-layer-composition.md) | `Layer.mergeAll` / `Layer.provide` / `provideMerge`, parameterized Layer factories, the worker-level layer set (ADR 0029) | Wiring services into the worker, adding a new feature Layer |
| [effect-errors.md](./effect-errors.md) | `Data.TaggedError` modeling, domain vs infra split, `_tag` → wire-code mapping | Designing a new error or feature's error set |
| [effect-error-operators.md](./effect-error-operators.md) | `Effect.catchTag`/`Tags`/`All`, `Effect.exit`, `Cause`/`Exit` inspection | Catching, recovering, or inspecting failures at a boundary |
| [effect-fn-tracing.md](./effect-fn-tracing.md) | `Effect.fn` for service methods, span naming conventions | Writing or naming a service method |
| [effect-testing.md](./effect-testing.md) | `@effect/vitest`, `it.effect`, unit-test guidance (Drizzle contract, fate-bridge, DO instance factories); integration redirects to `alchemy-test-harness.md` | Writing a unit test that drives Effect; first stop before writing any test |
| [effect-schema-validation.md](./effect-schema-validation.md) | `Schema.Class` for trust-boundary input validation | Validating untyped input (`HttpApi` payloads, external API responses, persisted JSON) |
| [effect-sse-externally-driven.md](./effect-sse-externally-driven.md) | `Stream.fromQueue` + `Stream.merge(keep-alive)` + `HttpServerResponse.stream`; the deliver path offers onto the queue | Building an SSE response written to from another component (e.g. the `LiveDO` topic role's `deliver` RPC) |

## Index — fate protocol layer

Read [fate-effect-bridge.md](./fate-effect-bridge.md) first — it's the seam everything else hangs off.

| Doc | Topic | Read when |
|---|---|---|
| [fate-effect-bridge.md](./fate-effect-bridge.md) | `fateQuery`/`fateList`/`fateMutation`/`fateSource`, `FateContext` carrying the captured service map, `encodeFateError` | The seam between fate and Effect — read first |
| [fate-data-views.md](./fate-data-views.md) | `dataView`/`Entity`/`computed`/`count`/`list`, selection masking, modeling conventions, raw IDs | Declaring an entity type |
| [fate-sources.md](./fate-sources.md) | Hand-built `SourceResolver`, Effect-backed `byId`/`byIds`/`connection` executors, never the Drizzle adapter | Wiring a view's reads to a service |
| [fate-mutations.md](./fate-mutations.md) | `mutations` map, validation in services, re-resolving the changed entity, delete returns the parent | Writing a mutation |
| [fate-connections.md](./fate-connections.md) | `ConnectionResult`, custom `lists` resolvers vs source `connection`, cursor ownership | Writing a paginated list |
| [fate-server-wiring.md](./fate-server-wiring.md) | `createFateServer` composition, the captured service map provided by the `/fate` route, codegen | Assembling/mounting the server |
| [per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md) | Per-feature `queries.ts`/`lists.ts`/`views.ts`/`shapers.ts`/`sources.ts`/`mutations.ts`; `features/fate/*` as barrels; SPA import surface preserved | Adding/moving a fate fragment, scaffolding a new feature ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |

## Index — fate client layer

Read [fate-client-setup.md](./fate-client-setup.md) first, then [fate-views-and-requests.md](./fate-views-and-requests.md).

| Doc | Topic | Read when |
|---|---|---|
| [fate-client-setup.md](./fate-client-setup.md) | `createFateClient`, `<FateClient>` provider, auth, generated client, Suspense/error rails | Wiring the client / app shell |
| [fate-views-and-requests.md](./fate-views-and-requests.md) | `view`/`useView`/`ViewRef`, masking, one batched `useRequest` per screen, `useListView` pagination | Reading data in a component |
| [fate-mutations-client.md](./fate-mutations-client.md) | `fate.mutations`/`actions`, optimistic updates, `insert`/`delete` membership, error routing | Writing data from the UI |
| [fate-live-views.md](./fate-live-views.md) | `useLiveView`/`useLiveListView`, server `live.*` publishing, the SSE wire, the unified `LiveDO` Durable Object | Making a view live (spans client + server) |

## Index — alchemy infra layer

The infra layer beneath the domain and fate layers. phoenix runs on [alchemy-effect](https://github.com/usirin/alchemy-effect) — one Effect program for infra + runtime, in place of `wrangler.jsonc`, a Hono entry, manual binding access, and hand-written DO classes. Read [alchemy-overview.md](./alchemy-overview.md) first; it maps how this layer sits under the unchanged `effect-*`/`fate-*` layers. phoenix and alchemy are both on effect v4.

| Doc | Topic | Read when |
|---|---|---|
| [alchemy-overview.md](./alchemy-overview.md) | One program = infra + runtime; the two phases; how the layers stack (domain/fate over alchemy); reading order | First — the mental model |
| [alchemy-worker.md](./alchemy-worker.md) | `Cloudflare.Worker<T>()(...)`, init vs runtime phase, props, providing binding Live layers | Defining/editing the worker entry |
| [alchemy-bindings.md](./alchemy-bindings.md) | `bind()` = deploy-policy + runtime-service; `yield*` DO vs `.bind` resource; the Live-layer convention | Reaching a Cloudflare resource |
| [alchemy-runtime.md](./alchemy-runtime.md) | **Load-bearing.** No per-request `ManagedRuntime`; worker-level vs request-scoped layers; `Effect.context()` capture; how the fate bridge runs the captured map | Touching the fate↔domain seam |
| [alchemy-http-router.md](./alchemy-http-router.md) | `HttpApiBuilder` for typed JSON + imperative `HttpRouter` for raw-Request/SSE; `toHttpEffect`; assets/worker-first | Adding/moving an HTTP route |
| [worker-http-transport-layout.md](./worker-http-transport-layout.md) | `worker/http/` as a transport surface (not a feature); `app.ts` composition (`makeAppLive`); the lone `health.ts` typed-JSON group; per-feature route modules merged in | Moving/adding an HTTP route, sanity-checking the http/ vs features/ split ([ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md)) |
| [worker-environment-pattern.md](./worker-environment-pattern.md) | Reading worker env at runtime via `Cloudflare.WorkerEnvironment` + one cast; why `Config`/`AppConfig` are wrong for plain policy vars; deploy-time `env:` literal vs runtime read | Reading `ENVIRONMENT` (or any plain binding) in worker code ([ADR 0031](../.decisions/0031-local-first-dev-state.md)) |
| [alchemy-durable-objects.md](./alchemy-durable-objects.md) | The unified `LiveDO` — `.make()`, role dispatch via `resolveRole(state.id.name)`, `LiveDO.from("phoenix")` self-namespace, KV storage, per-subscriber frame.id, the reap alarm | Working on the live DO ([ADR 0037](../.decisions/0037-unified-void-aligned-live-do.md)) |
| [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md) | `D1Connection.bind` → `raw` → `drizzle(raw,{schema})`; `Drizzle` as a worker-level singleton; migrations generated by `drizzle-kit` out-of-band, applied by alchemy via `D1Database({migrationsDir})` | Wiring the DB or migrations |
| [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) | `alchemy.run.ts` + `Alchemy.Stack`, resource declarations, `wrangler.jsonc`→alchemy map, dev/deploy, stages | Declaring resources or deploying |
| [alchemy-test-harness.md](./alchemy-test-harness.md) | `alchemy/Test/Core` deploy in `globalSetup` (main-process workaround for the pool-worker LoopbackServer race) + a black-box HTTP harness in the pool | Writing integration tests against the deployed worker |
| [better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md) | Forked `CloudflareD1` Layer on phoenix's existing D1; `Random` for the session secret; threading the resolved `Auth` instance to consumers without leaking `RuntimeContext` | Adding/editing better-auth plugins or wiring an auth consumer |

## Lint tooling

| Doc | Topic | Read when |
|---|---|---|
| [biome-custom-gritql-rules.md](./biome-custom-gritql-rules.md) | Authoring a project-specific lint rule as a biome GritQL plugin (`.grit` in `biome-plugins/`, registered in `biome.jsonc` `"plugins"`); the shipped `no-type-assertions` rule banning `as unknown as`/`as any`; per-line `// biome-ignore lint/plugin:` suppression | Adding/editing a custom biome lint rule, or suppressing one |

## Reference notes

Background research and considered-options docs that don't define current code but record why the current shape was picked. Read when revisiting a decision; skip when adding a feature.

| Doc | Topic | Read when |
|---|---|---|
| [live-fan-out-options-considered.md](./live-fan-out-options-considered.md) | partyserver / partysub / Agents SDK / `@cloudflare/actors` / SaaS — what was surveyed for live fan-out and why we stayed on alchemy DOs + native SSE | Revisiting the live-channel build-vs-buy ([ADR 0034](../.decisions/0034-fate-native-sse-protocol.md)) |

## fate protocol conventions

- **fate is pure transport; Effect services are the domain.** Reads and writes go through service methods — fate never queries the database, and `createDrizzleSourceAdapter` is never used.
- **No `runtime.runPromise*` outside the bridge.** Resolvers and source executors are Effect generators wrapped by `fateQuery`/`fateList`/`fateMutation`/`fateSource`.
- **Validation lives in services** (ADR 0013). fate's `input` schema is thin shape-coercion only.
- **The server is the single source of truth for types.** The client imports `Entity<>` types; codegen emits the client wiring. No schema artifact.
- **One batched request per screen.** A screen root declares its whole view tree in one `useRequest`; child `useView` calls read from cache — no waterfalls. Mutations are declarative (`optimistic`, `insert`/`delete`); no imperative cache updaters.
- **Live views run over SSE through the unified `LiveDO` Durable Object.** The built-in in-memory bus can't fan out across Worker isolates, so a publish-only `LiveEventBus` fires the topic-role `publish` RPC; a `topic:` instance owns the subscriber registry and fans out to `connection:` instances, which hold the SSE streams. One class plays both roles, keyed by instance name (ADR 0037, reunifying the 0025 split). This is the one Durable Object in phoenix.

## Conventions across these docs

- **All patterns are effect v4** (`effect@4.0.0-beta.*`). Earlier `@effect/sql-drizzle`-style examples don't apply directly.
- **Drizzle is the query builder.** Exposed as `DrizzleAccess` methods you destructure (`const {run, batch} = yield* Drizzle`) — feature code never writes `Effect.tryPromise` directly.
- **House rule: `Effect.tryPromise` always uses object notation** with an explicit `catch` producing a tagged error. The single-arg form is treated like `Effect.promise`.
- **Service methods always use `Effect.fn("Service.method")(function*(args) {...})`** — automatic spans, automatic stack frames. Reserve `Effect.fnUntraced` for genuinely hot internal helpers.
- **One service per feature folder.** Reads + writes coexist.
- **Testing strategy:** product code → integration tests via the alchemy/Test deploy + black-box HTTP harness ([alchemy-test-harness.md](./alchemy-test-harness.md)). Infrastructure (the `Drizzle` service, the fate bridge, the DO instance factories) → isolation tests under `@effect/vitest` ([effect-testing.md](./effect-testing.md)).

## When to add a new pattern doc here

Add a doc when:

- A pattern is used in **2+ places** and future agents will need to know it.
- The pattern is **non-obvious from reading the codebase** — it codifies a design choice rather than describing existing structure.
- A future agent would otherwise **invent a worse version** if they didn't know about it.

Don't add a doc for:

- One-off implementation details.
- Things that are obvious from reading the code.
- Migration steps (those go in vault grill/RFC artifacts, not here).
