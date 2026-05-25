# The fate ↔ Effect bridge

How fate's resolvers and source handlers run phoenix domain logic. The short answer: a small family of helpers — `fateQuery`, `fateList`, `fateMutation`, `fateSource` — wraps an Effect generator into the plain-async function fate expects, running it through the per-request `ManagedRuntime`. Feature code never calls `runtime.runPromise*` directly.

This is the **load-bearing seam** of the backend. The Effect domain services (Sozluk, Pano, Vote, Pasaport, Stats) are protocol-neutral — see [feature-services.md](./feature-services.md). The bridge is the single place they meet the wire.

## The fate context carries the runtime

`createFateServer({context})` produces a per-request context object that every resolver and source handler receives as `ctx`. In phoenix that object carries the request's `ManagedRuntime`:

```ts
// worker/fate/context.ts
import type {ManagedRuntime} from "effect";
import type {FateRuntime} from "./runtime";

export interface FateContext {
  readonly runtime: ManagedRuntime.ManagedRuntime<FateRuntime.Context, never>;
  readonly request: Request;
}
```

Session is **not** a field on `FateContext`. It is baked into the runtime's `Auth` layer when the runtime is built ([fate-server-wiring.md](./fate-server-wiring.md)), so resolvers read it with `yield* Auth.required`.

## The low-level runner

One function does the `runtime → Exit → wire-error` dance. Everything else funnels through it:

```ts
// worker/fate/effect.ts
import {Cause, Effect, Exit} from "effect";
import {FateRequestError} from "@nkzw/fate/server";
import {encodeFateError} from "./errors";
import type {FateContext} from "./context";

const runEffect = <A>(
  ctx: FateContext,
  effect: Effect.Effect<A, unknown, FateRuntime.Context>,
): Promise<A> =>
  ctx.runtime.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const found = Cause.findError(exit.cause);
    if (found._tag === "Success") {
      const e = found.success;
      // Already wire-shaped (resolver-side validation, Auth) → pass through.
      if (e instanceof FateRequestError) throw e;
      throw encodeFateError(e);
    }
    // Defects (uncaught throw that never became an Effect failure).
    throw encodeFateError(Cause.squash(exit.cause));
  });
```

`FateRequestError` instances pass through verbatim — that's the escape hatch for code that already knows its wire shape. Every other failure goes through `encodeFateError`, which maps domain `_tag`s onto stable codes (below).

## The helper family

fate has four callback shapes; each gets one wrapper. All take an Effect generator and return the plain-async function fate invokes.

```ts
type Selection = ReadonlyArray<string>;

// Root query: ({ctx, input:{args}, select}) => Promise<Output>
export const fateQuery =
  <Args, A>(body: (o: {args: Args | undefined; select: Selection}) => Generator<any, A, any>) =>
  ({ctx, input, select}: {ctx: FateContext; input: {args?: Args}; select: Array<string>}) =>
    runEffect(ctx, Effect.gen(() => body({args: input.args, select})));

// Root list: same, but returns a ConnectionResult (see fate-connections.md)
export const fateList =
  <Args, A>(
    body: (o: {args: Args | undefined; select: Selection}) => Generator<any, ConnectionResult<A>, any>,
  ) =>
  ({ctx, input, select}: {ctx: FateContext; input: {args?: Args}; select: Array<string>}) =>
    runEffect(ctx, Effect.gen(() => body({args: input.args, select})));

// Mutation: ({ctx, input, select}) => Promise<Output>
export const fateMutation =
  <Input, A>(body: (o: {input: Input; select: Selection}) => Generator<any, A, any>) =>
  ({ctx, input, select}: {ctx: FateContext; input: Input; select: Array<string>}) =>
    runEffect(ctx, Effect.gen(() => body({input, select})));
```

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

> **`SourceExecutor` is not exported.** `@nkzw/fate/server` re-exports `SourceRegistry` and `SourceDefinition` but **not** the `SourceExecutor` type. Recover the executor type from the registry's value half — `type SourceExecutor = SourceRegistry<FateContext> extends Map<unknown, infer V> ? V : never` — rather than importing the unexported name. Under `exactOptionalPropertyTypes`, build the executor as **one object literal with conditional spreads** (not conditional property assignment), or the optional fields widen to `… | undefined` and fail to match fate's shape.

```ts
import type {SourceRegistry} from "@nkzw/fate/server";

type SourceExecutor = SourceRegistry<FateContext> extends Map<unknown, infer V> ? V : never;

export const fateSource = <Item extends Record<string, unknown>>(handlers: {
  byId?: (id: string) => Generator<any, Item | null, any>;
  byIds?: (ids: ReadonlyArray<string>) => Generator<any, ReadonlyArray<Item>, any>;
  connection?: (page: {
    cursor?: string;
    direction: "forward" | "backward";
    take: number;
    skip?: number;
  }) => Generator<any, ReadonlyArray<Item>, any>;
}): SourceExecutor => {
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

`genEffect` is the single `Effect.gen(body) as Effect.Effect<A, unknown, FateRuntime.Context>` assertion the bridge makes: the generators yield heterogeneous services (`any` element type), so `Effect.gen` infers env `unknown`; we assert it back to the runtime's context, which it provides at run time.

See [fate-sources.md](./fate-sources.md) for how these executors wire into the `SourceResolver` and which service backs each type.

## Mapping failures to fate error codes

Domain failures surface as `FateRequestError(code, message)`, which serializes to `{ok: false, error: {code, message, issues?}}` on the wire. `encodeFateError` maps each `Data.TaggedError._tag` onto a stable wire code; the codes are shared with the SPA (`src/lib/mutationErrorCodes.ts`) so it decodes the same constants regardless of where they're raised.

> **`FateRequestError`'s `code` is typed narrow.** Its constructor types `code: FateProtocolErrorCode` — a closed 6-member protocol union (`BAD_REQUEST | FORBIDDEN | INTERNAL_ERROR | NOT_FOUND | UNAUTHORIZED | VALIDATION_ERROR`). phoenix's wire vocabulary is the wider `MutationErrorCode` set (`BODY_REQUIRED`, `TAKEN`, `DEFINITION_NOT_FOUND`, …). At run time the constructor stores whatever string it's given and fate forwards it verbatim on the wire, so widen the constructor through a one-line `fateError(code, message)` helper that accepts any `MutationErrorCode` and casts. `Unauthorized → "UNAUTHORIZED"` happens to be a real protocol code; the rest ride through the cast.

```ts
// worker/fate/errors.ts
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

- **No `runtime.runPromise` in feature code or resolver bodies.** If you reach for it, you're missing a helper — add one.
- **No domain logic in the bridge.** It runs effects and maps errors. Validation, pagination, karma all live in services ([feature-services.md](./feature-services.md), [ADR 0013](../.decisions/0013-validation-in-service-methods.md)).

## See also

- [fate-server-wiring.md](./fate-server-wiring.md) — building the per-request runtime + mounting on Hono
- [fate-sources.md](./fate-sources.md) — the `SourceResolver` and Effect-backed executors
- [fate-mutations.md](./fate-mutations.md) — `fateMutation` + re-resolving the changed entity
- [effect-error-operators.md](./effect-error-operators.md) — `Cause`/`Exit` inspection the runner relies on
