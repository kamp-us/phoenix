# The fate ↔ Effect bridge

How fate's resolvers and source handlers run phoenix domain logic. The short answer: a small family of helpers — `fateQuery`, `fateList`, `fateMutation`, `fateSource` — wraps an Effect generator into the plain-async function fate expects, running it **through the worker-level `ManagedRuntime`** carried on `ctx.runtime` (ADR 0041, supersedes 0029). Feature code never calls `Effect.runPromise*` directly.

This is the **load-bearing seam** of the backend. The Effect domain services (Sozluk, Pano, Vote, Pasaport, Stats) are protocol-neutral — see [feature-services.md](./feature-services.md). The bridge is the single place they meet the wire. It is also the framework's foreign-async integration seam: fate's resolvers are plain `(args) => Promise`, and a `ManagedRuntime` is the effect-smol-documented way to call Effect code from such a non-Effect callback boundary — see "the runtime is the documented integration seam" below.

## The fate context carries the runtime + the two per-request values

`createFateServer({context})` produces a per-request context object that every resolver and source handler receives as `ctx`. In phoenix that object carries the worker-level `ManagedRuntime` (one per isolate — [alchemy-runtime.md](./alchemy-runtime.md)) plus the two genuinely per-request service VALUES, `auth` and `liveBus`:

```ts
// worker/features/fate/context.ts
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type {LiveBus} from "../fate-live/event-bus";
import type {Auth} from "../pasaport/Auth";
import type {WorkerFateServices} from "./layers";

export interface FateContext<R = WorkerFateServices> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly request: Request;
  readonly auth: typeof Auth.Service;
  readonly liveBus: typeof LiveBus.Service;
}
```

`FateContext` is **generic in the runtime environment `R`** (defaulting to the production `WorkerFateServices`) so a test can wrap a `FateContext` over a tiny marker runtime with no cast; production sites take the default. Carrying `auth`/`liveBus` as VALUES (not a captured `Context` or a bundled `provideRequest` closure) makes the per-request contract explicit and invalid states unrepresentable: a `FateContext` cannot exist without both, and the bridge cannot forget to provide one.

Session is **not** a field on `FateContext`. It rides inside `auth`, provided onto each resolver effect when the bridge runs it ([alchemy-runtime.md](./alchemy-runtime.md)), so resolvers read it with `yield* Auth.required`.

## The low-level runner

One function does the `provide(Auth/LiveBus) → run-on-runtime → Exit → wire-error` dance. Everything else funnels through it:

```ts
// worker/features/fate/effect.ts
import {Cause, Effect, Exit, Option} from "effect";
import {FateRequestError} from "@nkzw/fate/server";
import {LiveBus} from "../fate-live/event-bus";
import {Auth} from "../pasaport/Auth";
import {encodeFateError} from "./errors";
import type {FateContext} from "./context";

const runEffect = <A, R>(
  ctx: FateContext<R>,
  effect: Effect.Effect<A, unknown, R | Auth | LiveBus>,
): Promise<A> =>
  ctx.runtime
    .runPromiseExit(
      effect.pipe(
        Effect.provideService(Auth, ctx.auth),
        Effect.provideService(LiveBus, ctx.liveBus),
      ),
      // Wire the request's abort signal so a disconnected fate client interrupts
      // the resolver fiber.
      {signal: ctx.request.signal},
    )
    .then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      // Unwind the Cause with `findErrorOption` (an `Option`) so no `Result`
      // tag leaks into boundary code.
      return Option.match(Cause.findErrorOption(exit.cause), {
        // Already wire-shaped (resolver-side validation, Auth) → pass through.
        onSome: (e) => {
          throw e instanceof FateRequestError ? e : encodeFateError(e);
        },
        // Defects (uncaught throw that never became an Effect failure).
        onNone: () => {
          throw encodeFateError(Cause.squash(exit.cause));
        },
      });
    });
```

Four things to read off the runner:

- **`ctx.runtime.runPromiseExit(...)`, not `Effect.runPromiseExit(Effect.provide(...))`.** The resolver runs THROUGH the worker-level runtime, so its spans nest under the runtime's request span rather than on a detached default-runtime root. This is the **F4 observability win** (ADR 0041): resolver spans are children of the request, not roots. There is no `Effect.runPromiseExit` / `Effect.provide(effect, ctx.context)` anywhere — `ctx.runtime` is the only run boundary.
- **`Effect.provideService(Auth, ctx.auth)` + `Effect.provideService(LiveBus, ctx.liveBus)`** discharge the two genuinely per-request services onto the effect. The effect's environment is `R | Auth | LiveBus`; providing those two leaves exactly `R`, which is the runtime's own environment.
- **The abort signal** (`{signal: ctx.request.signal}`) wires the request's `AbortSignal` to the resolver fiber, so a disconnected fate client interrupts the work in flight.
- **`Cause.findErrorOption` + `Option.match`** unwind the failure — no `._tag === "Success"` `Result` check leaks into boundary code. `FateRequestError` instances pass through verbatim; every other failure goes through `encodeFateError`; defects (uncaught throws that never became Effect failures) are squashed with `Cause.squash` and then encoded.

This is the single place a runtime is run in the codebase. Worker-level Layers are built once in init (`makeFateLayer` in `features/fate/layers.ts`) and carried by the one `ManagedRuntime` ([alchemy-runtime.md](./alchemy-runtime.md)); the route builds the two per-request values; the bridge provides them onto each resolver Effect and runs it on `ctx.runtime`. There is nothing built or disposed per request.

`FateRequestError` instances pass through verbatim — that's the escape hatch for code that already knows its wire shape. Every other failure goes through `encodeFateError`, which maps domain `_tag`s onto stable codes (below).

## The runtime is the documented integration seam

The `ManagedRuntime` here is not a phoenix invention: it is the **effect-smol-documented way to integrate Effect into an existing application**. effect-smol's `LLMS.md` ("Integrating Effect into existing applications" section, with the `ai-docs/src/03_integration/10_managed-runtime.ts` example) describes exactly this shape — build one `ManagedRuntime` from your application's layers, then call `runtime.runPromise*` from each non-Effect callback. fate's `(args) => Promise` resolvers ARE that non-Effect callback boundary, so the runner is a faithful application of the documented idiom rather than a clever local trick.

**Framework seam, kept app-local.** The bridge is a framework primitive (it would be reusable by any fate-on-Effect worker), but it is born in-app and stays under `worker/features/fate/` — it has not graduated to a shared package (ADR 0040 Gate B unmet). Document it as a pattern; don't extract it yet. See [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) and [ADR 0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md).

## The helper family

fate has four callback shapes; each gets one wrapper. All take an Effect generator and return the plain-async function fate invokes.

```ts
type Selection = ReadonlyArray<string>;

// Root query: ({ctx, input:{args}, select}) => Promise<Output>
export const fateQuery =
  <Args, A>(body: (o: {args: Args | undefined; select: Selection}) => Generator<any, A, any>) =>
  <R>({ctx, input, select}: {ctx: FateContext<R>; input: {args?: Args}; select: Array<string>}) =>
    runEffect(ctx, genEffect(() => body({args: input.args, select})));

// Root list: same, but returns a ConnectionResult (see fate-connections.md)
export const fateList =
  <Args, A>(
    body: (o: {args: Args | undefined; select: Selection}) => Generator<any, ConnectionResult<A>, any>,
  ) =>
  <R>({ctx, input, select}: {ctx: FateContext<R>; input: {args?: Args}; select: Array<string>}) =>
    runEffect(ctx, genEffect(() => body({args: input.args, select})));

// Mutation: ({ctx, input, select}) => Promise<Output>
export const fateMutation =
  <Input, A>(body: (o: {input: Input; select: Selection}) => Generator<any, A, any>) =>
  <R>({ctx, input, select}: {ctx: FateContext<R>; input: Input; select: Array<string>}) =>
    runEffect(ctx, genEffect(() => body({input, select})));
```

Each wrapper is generic in the runtime env `R` (matching `FateContext<R>`), so the per-feature resolver registries slot into fate's server constraint cast-free and the isolation tests can drive a wrapper with a marker-runtime `ctx`.

A resolver reads as a thin orchestration over a service:

```ts
queries: {
  me: {type: "User", resolve: fateQuery(function* () {
    const {user} = yield* Auth.required;       // Unauthorized → UNAUTHORIZED
    const pasaport = yield* Pasaport;
    return yield* pasaport.getUserById(user.id);
  })},
},
```

## Source handlers — `fateSource`

Source executors (`byId` / `byIds` / `connection`) feed fate's read path. They return **raw domain rows**, not shaped output: fate masks each row to the requested view+selection afterward via the source plan (`plan.resolveMany`), so handlers never receive `select` — they just fetch. fate **does** pass each handler a `plan` argument; our wrapper ignores it (the masking happens after the handler returns).

> **`SourceExecutor` is not exported.** `@nkzw/fate/server` re-exports `SourceRegistry` and `SourceDefinition` but **not** the `SourceExecutor` type. Recover the executor type from the registry's value half — `type SourceExecutor<R = WorkerFateServices> = SourceRegistry<FateContext<R>> extends Map<unknown, infer V> ? V : never` — rather than importing the unexported name. It is **generic in `R`** (matching `FateContext<R>`) so production registries take the default and the isolation tests can name a marker `R`, both cast-free. Under `exactOptionalPropertyTypes`, build the executor as **one object literal with conditional spreads** (not conditional property assignment), or the optional fields widen to `… | undefined` and fail to match fate's shape.

```ts
import type {SourceRegistry} from "@nkzw/fate/server";
import type {WorkerFateServices} from "./layers";

type SourceExecutor<R = WorkerFateServices> =
  SourceRegistry<FateContext<R>> extends Map<unknown, infer V> ? V : never;

export const fateSource = <Item extends Record<string, unknown>, R = WorkerFateServices>(handlers: {
  byId?: (id: string) => Generator<any, Item | null, any>;
  byIds?: (ids: ReadonlyArray<string>) => Generator<any, ReadonlyArray<Item>, any>;
  connection?: (page: {
    cursor?: string;
    direction: "forward" | "backward";
    take: number;
    skip?: number;
  }) => Generator<any, ReadonlyArray<Item>, any>;
}): SourceExecutor<R> => {
  const {byId, byIds, connection} = handlers;
  return {
    ...(byId ? {byId: ({ctx, id}) => runEffect(ctx, genEffect(() => byId(id)))} : {}),
    ...(byIds
      ? {byIds: ({ctx, ids}) => runEffect(ctx, genEffect(() => byIds(ids))).then((r) => [...r])}
      : {}),
    // connection spreads cursor/skip only when defined (exactOptionalPropertyTypes)
    ...(connection ? {connection: ({ctx, cursor, direction, take, skip}) => /* … */} : {}),
  };
};
```

### The F7 cast (permanent)

`genEffect` is the single `Effect.gen(body) as Effect.Effect<A, unknown, R>` assertion the bridge makes: the generators yield heterogeneous services (`any` element type), so `Effect.gen` infers env `unknown`; we assert it back to `R`, the runtime's environment.

```ts
const genEffect = <A, R>(body: () => Generator<any, A, any>): Effect.Effect<A, unknown, R> =>
  Effect.gen(body) as Effect.Effect<A, unknown, R>;
```

**This cast is irreducible — keep it (F7, ADR 0041).** Two facts make it permanent, not a TODO:

- `Effect.gen.Return` pins the error channel `E` to `never`, which rejects failing resolvers (a body that does `yield* new BodyRequired(...)` or `yield* Auth.required` — `DrizzleError`, `Unauthorized`).
- `R` in the generator yield position is **contravariant**: a narrow-`R` body (`yield* Sozluk`) does not satisfy the wider `R`, and the friction cascades into fate's `QueryDefinition<FateContext<WorkerFateServices>>` server constraint.

It is kept as one plain `as` (not `as any` / `as unknown as`): resolver bodies are still type-checked at their own definition sites, and `runEffect` runs them on a runtime that surfaces a wrong environment as a runtime "service not found", not a silent miss. See [ADR 0041](../.decisions/0041-fate-bridge-worker-managed-runtime.md) (F7).

See [fate-sources.md](./fate-sources.md) for how these executors wire into the `SourceResolver` and which service backs each type.

## Mapping failures to fate error codes

Domain failures surface as `FateRequestError(code, message)`, which serializes to `{ok: false, error: {code, message, issues?}}` on the wire. `encodeFateError` maps each `Data.TaggedError._tag` onto a stable wire code; the codes are shared with the SPA (`src/lib/mutationErrorCodes.ts`) so it decodes the same constants regardless of where they're raised.

> **`FateRequestError`'s `code` is typed narrow.** Its constructor types `code: FateProtocolErrorCode` — a closed 6-member protocol union (`BAD_REQUEST | FORBIDDEN | INTERNAL_ERROR | NOT_FOUND | UNAUTHORIZED | VALIDATION_ERROR`). phoenix's wire vocabulary is the wider `MutationErrorCode` set (`BODY_REQUIRED`, `TAKEN`, `DEFINITION_NOT_FOUND`, …). At run time the constructor stores whatever string it's given and fate forwards it verbatim on the wire, so widen the constructor through a one-line `fateError(code, message)` helper that accepts any `MutationErrorCode` and casts. `Unauthorized → "UNAUTHORIZED"` happens to be a real protocol code; the rest ride through the cast.

```ts
// worker/features/fate/errors.ts
import {FateRequestError} from "@nkzw/fate/server";
import type {MutationErrorCode} from "../../src/lib/mutationErrorCodes"; // shared wire contract

// Widen fate's narrow FateProtocolErrorCode constructor to phoenix's vocabulary.
const fateError = (code: MutationErrorCode, message: string) =>
  new FateRequestError(code as never, message);

export const encodeFateError = (e: unknown): FateRequestError => {
  if (e instanceof FateRequestError) return e;
  const tag = (e as {_tag?: string} | null | undefined)?._tag;
  switch (tag) {
    case "sozluk/BodyRequired": return fateError("BODY_REQUIRED", "tanım boş olamaz");
    case "Unauthorized":        return fateError("UNAUTHORIZED", "not authorized");
    // …one arm per Data.TaggedError…
  }
  return fateError("INTERNAL_SERVER_ERROR", "Something went wrong.");
};
```

`src/lib/mutationErrorCodes.ts` is the single source of truth for the codes. See [effect-errors.md](./effect-errors.md) for how the `_tag`s are designed.

## What stays out of the bridge

- **No `Effect.runPromise*` in feature code or resolver bodies.** The bridge's `runEffect` is the only place it appears. If you reach for it elsewhere, you're missing a helper — add one.
- **No domain logic in the bridge.** It runs effects and maps errors. Validation, pagination, karma all live in services ([feature-services.md](./feature-services.md), [ADR 0013](../.decisions/0013-validation-in-service-methods.md)).

## See also

- [fate-server-wiring.md](./fate-server-wiring.md) — composing `createFateServer` and mounting on the imperative `HttpRouter.add` route
- [fate-sources.md](./fate-sources.md) — the `SourceResolver` and Effect-backed executors
- [fate-mutations.md](./fate-mutations.md) — `fateMutation` + re-resolving the changed entity
- [effect-error-operators.md](./effect-error-operators.md) — `Cause`/`Exit` inspection the runner relies on
