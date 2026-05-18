# Phoenix patterns

Reusable patterns for writing phoenix backend code. These are **evergreen** — they describe how the codebase is structured, not how to migrate to it. Treat them as the load-bearing references when adding features, fixing bugs, or onboarding a new agent.

Start with [effect-context-service.md](./effect-context-service.md) and [feature-services.md](./feature-services.md). The rest fill in.

## Index

| Doc | Topic | Read when |
|---|---|---|
| [effect-context-service.md](./effect-context-service.md) | Class-form services, layer shapes, `return yield*`, service-method shape | Defining a new service or layer |
| [feature-services.md](./feature-services.md) | One service per feature folder, `Drizzle` capability service, `Drizzle.run`/`Drizzle.batch` callbacks | Adding a feature service, writing service methods |
| [effect-layer-composition.md](./effect-layer-composition.md) | `Layer.mergeAll` / `Layer.provide` / `ManagedRuntime`, the graphql + admin two-runtime story | Wiring services into a runtime, adding a new runtime |
| [effect-errors.md](./effect-errors.md) | `Data.TaggedError` modeling, domain vs infra split, `_tag` → wire-code mapping | Designing a new error or feature's error set |
| [effect-error-operators.md](./effect-error-operators.md) | `Effect.catchTag`/`Tags`/`All`, `Effect.exit`, `Cause`/`Exit` inspection | Catching, recovering, or inspecting failures at a boundary |
| [effect-fn-tracing.md](./effect-fn-tracing.md) | `Effect.fn` for service methods, span naming conventions | Writing or naming a service method |
| [effect-testing.md](./effect-testing.md) | `@effect/vitest`, `it.effect`, integration tests via miniflare, when to use unit tests | Writing tests for features or infrastructure |
| [effect-schema-validation.md](./effect-schema-validation.md) | `Schema.Class` for trust-boundary input validation | Validating untyped input (GraphQL inputs, Hono bodies, external APIs) |

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
