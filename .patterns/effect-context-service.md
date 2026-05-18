# Context.Service pattern

How to define and wire services in phoenix's worker, following the conventions used in `~/code/github.com/usirin/effect-smol/` (the canonical effect codebase).

## Defining a service — class form, always

The class form is the canonical pattern in effect-smol. Use it for every service, even one-field ones.

```ts
import {Context} from "effect";

export class Auth extends Context.Service<
  Auth,
  {
    readonly user: Session["user"] | undefined;
    readonly session: Session["session"] | undefined;
  }
>()("@phoenix/worker/Auth") {}
```

Three pieces, in order:

1. **Self type** (`Auth`) — the class itself, used as the tag.
2. **Service shape** (`{readonly ...}`) — the API.
3. **String id** (`"@phoenix/worker/Auth"`) — must be globally unique. Namespace it `@phoenix/<package>/<Name>` so collisions are obvious.

The string id is what effect uses at runtime to look services up. Renaming the class is fine; renaming the string id breaks every layer providing it.

### Why class form over `Context.Tag`/`Context.GenericTag`

- The class **is** the tag — `yield* Auth` gives you the service shape directly. No separate `AuthTag` and `Auth` interface to keep in sync.
- You can attach static helpers (`Auth.required`, see below) and they stay namespaced with the service.
- Subclassing extends the interface without re-declaring the tag.

### Service shape rules

- All fields `readonly`. Services are not mutable.
- Methods return `Effect.Effect<A, E, R>` — never `Promise`. If you have a Promise-based dep (drizzle, fetch), wrap it at the service boundary, not at the call site.
- Errors go in the `E` channel via tagged errors (`Data.TaggedError` or `Schema.TaggedErrorClass`). No thrown exceptions across service boundaries.

```ts
class UserRepo extends Context.Service<
  UserRepo,
  {
    readonly byId: (id: string) => Effect.Effect<User, UserNotFound | RepoError>;
    readonly list: Effect.Effect<ReadonlyArray<User>, RepoError>;
  }
>()("@phoenix/worker/UserRepo") {}
```

## Static helpers on the service class

Effect-smol attaches reusable derivations as static fields. Phoenix already does this in `worker/services/Auth.ts`:

```ts
export class Auth extends Context.Service<Auth, {...}>()("@phoenix/worker/Auth") {
  static readonly required = Effect.gen(function*() {
    const auth = yield* Auth;
    if (!auth.user) {
      return yield* new Unauthorized({message: "Authentication required"});
    }
    return {user: auth.user, session: auth.session};
  });
}
```

Call site: `const {user} = yield* Auth.required;`

Use this when the same gen-block recurs at five call sites. Don't pre-derive every possible helper — only the ones that already exist as copy-pasted blocks.

## Building layers — three shapes

### `Layer.succeed` — pure, eager value

```ts
export const layer: Layer.Layer<Path> = Layer.succeed(Path)(posixImpl);
```

Use when constructing the service has zero deps and zero effects — a plain object literal of functions.

### `Layer.effect` — service built inside an Effect

```ts
export const layer = Layer.effect(UserRepo)(
  Effect.gen(function*() {
    const db = yield* Database;
    return {
      byId: (id) => Effect.tryPromise({try: () => db.select()...}),
      list: Effect.tryPromise({try: () => db.select()...}),
    };
  })
);
```

Use when the service needs other services from the context (here, `Database`). The resulting layer carries `R = Database` until that's provided.

### `Layer.effectContext` — providing multiple tags from one construction

Used by `@effect/sql-d1` to bind both `D1Client` and the generic `SqlClient` from one `make()` call:

```ts
export const layer = (config: D1ClientConfig): Layer.Layer<D1Client | SqlClient, ConfigError> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(D1Client, client).pipe(Context.add(SqlClient, client))
    )
  );
```

Use only when one implementation legitimately satisfies multiple service tags. Don't reach for this otherwise — two `Layer.effect` calls compose cleaner.

## Accessing services

Inside `Effect.gen`:

```ts
Effect.gen(function*() {
  const env = yield* CloudflareEnv;
  const auth = yield* Auth;
  // ...
});
```

Outside gen, point-free:

```ts
Effect.flatMap(UserRepo, (repo) => repo.byId(userId));
```

Prefer gen — `yield* Service` reads identically to `const service = ...`.

## Providing services

```ts
const program = handler.pipe(
  Effect.provideService(CloudflareEnv, env),
  Effect.provideService(Auth, {user, session}),
  Effect.provide(UserRepo.layer),     // layer, when construction is non-trivial
);
```

`provideService` for ready-made values, `provide(layer)` for everything else. Compose layers with `Layer.mergeAll` / `Layer.provide` at the worker entry, not inside resolvers.

## Method shape — `Effect.fn` over `Effect.gen` for service methods

Service methods are functions you call multiple times per request. Define them with `Effect.fn("Service.method")(function*(args) {...})` so each invocation gets a named span and stack frame. See [effect-fn-tracing.md](./effect-fn-tracing.md) for the full rules.

```ts
// service method — Effect.fn gets a named span per call
const byId = Effect.fn("UserRepo.byId")(function*(id: string) {
  // ...
});

// resolver / one-off composition — Effect.gen is fine, the wrapper traces it
resolver(function*(_source, args) {
  const repo = yield* UserRepo;
  return yield* repo.byId(args.id);
});

// hot-path internal helper (rare in phoenix) — Effect.fnUntraced skips the span
const transform = Effect.fnUntraced(function*(row: Row) {
  // ...
});
```

## See also

- [feature-services.md](./feature-services.md) — how to organize phoenix features as one service each, layered on `Drizzle`
- [effect-layer-composition.md](./effect-layer-composition.md) — composing layers, ManagedRuntime, multi-runtime wiring
- [effect-errors.md](./effect-errors.md) — tagged errors for the `E` channel
- [effect-error-operators.md](./effect-error-operators.md) — catching and inspecting failures
- [effect-fn-tracing.md](./effect-fn-tracing.md) — when to use `Effect.fn` vs `Effect.fnUntraced`
- [effect-testing.md](./effect-testing.md) — testing Effect-based code
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema` for trust-boundary validation
- Existing examples: `worker/services/Auth.ts`, `worker/services/CloudflareEnv.ts`, `worker/services/RequestContext.ts`
