# The fate ↔ Effect bridge

How fate's resolvers and source handlers run phoenix domain logic. The short answer: a small family of helpers — `fateQuery`, `fateList`, `fateMutation`, `fateSource` — wraps an Effect generator into the plain-async function fate expects, running it on the **one isolate-level `ManagedRuntime`** carried by the `FateContext` (ADR 0029). Feature code never calls `Effect.runPromise*` directly.

This is the **load-bearing seam** of the backend. The Effect domain services (Sozluk, Pano, Vote, Pasaport, Stats) are protocol-neutral — see [feature-services.md](./feature-services.md). The bridge is the single place they meet the wire.

## The fate context carries the runtime + the two per-request service values

`createFateServer({context})` produces a per-request context object that every resolver and source handler receives as `ctx`. In phoenix (the F4 model, ADR 0029) that object carries the **one worker-level `ManagedRuntime`** — built once per isolate in worker init, never disposed per request — plus the two genuinely per-request services as VALUES (`auth`, `liveBus`) and the raw `request`:

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

Carrying `auth`/`liveBus` as VALUES (rather than a captured `Context` or a `provideRequest` closure) makes the per-request contract explicit and invalid states unrepresentable: a `FateContext` cannot exist without both, and the bridge cannot forget to provide one. Session is **not** a field — it lives inside `auth`, read with `yield* Auth.required`. The interface is generic in the runtime env `R` (default `WorkerFateServices`) so a test can drive a resolver on a tiny marker runtime cast-free.

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
      // The request's AbortSignal interrupts the resolver fiber if the
      // fate client disconnects (matches HttpEffect's run-with-signal contract).
      {signal: ctx.request.signal},
    )
    .then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      // Cause.findErrorOption keeps the Result tag out of boundary code.
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

This is the single place `runPromiseExit` appears in the codebase. Worker-level Layers are built once in init (`makeFateLayer` in `features/fate/layers.ts`) into the one `ManagedRuntime`; the bridge provides only the two per-request service VALUES (`Auth`, `LiveBus`) onto each resolver Effect and runs it THROUGH that runtime — so resolver spans nest under the runtime's request span and nothing is built or disposed per request. Providing `Auth`/`LiveBus` discharges those two, leaving exactly the runtime's own env `R`.

`FateRequestError` instances pass through verbatim — that's the escape hatch for code that already knows its wire shape. Every other failure goes through `encodeFateError`, which maps domain `_tag`s onto stable codes (below).

## The helper family

fate has four callback shapes; each gets one wrapper. All take an Effect generator and return the plain-async function fate invokes.

Each body is a `Generator<any, A, any>` (resolver bodies `yield*` heterogeneous services and fail with arbitrary tagged errors, so the yield is `any`). The runtime env `R` is the **inner** returned function's generic — inferred from the `ctx` fate passes at invocation, so production gets `WorkerFateServices` and the isolation tests get their marker `R`, neither naming it. `genEffect` asserts the env to `R` (the bridge's single contained boundary cast — see below).

```ts
type Selection = ReadonlyArray<string>;

// Root query: ({ctx, input:{args}, select}) => Promise<Output>
export const fateQuery =
  <Args, A>(body: (o: {args: Args | undefined; select: Selection}) => Generator<any, A, any>) =>
  <R>({ctx, input, select}: QueryArgs<Args, R>) =>
    runEffect(ctx, genEffect(() => body({args: input.args, select})));

// Root list: same, but returns a ConnectionResult (see fate-connections.md)
export const fateList =
  <Args, A>(
    body: (o: {args: Args | undefined; select: Selection}) => Generator<any, ConnectionResult<A>, any>,
  ) =>
  <R>({ctx, input, select}: QueryArgs<Args, R>) =>
    runEffect(ctx, genEffect(() => body({args: input.args, select})));

// Mutation: ({ctx, input, select}) => Promise<Output>
export const fateMutation =
  <Input, A>(body: (o: {input: Input; select: Selection}) => Generator<any, A, any>) =>
  <R>({ctx, input, select}: MutationArgs<Input, R>) =>
    runEffect(ctx, genEffect(() => body({input, select})));
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

> **`SourceExecutor` is not exported.** `@nkzw/fate/server` re-exports `SourceRegistry` and `SourceDefinition` but **not** the `SourceExecutor` type. Recover the executor type from the registry's value half — `type SourceExecutor<R = WorkerFateServices> = SourceRegistry<FateContext<R>> extends Map<unknown, infer V> ? V : never` — rather than importing the unexported name. Under `exactOptionalPropertyTypes`, build the executor as **one object literal with conditional spreads** (not conditional property assignment), or the optional fields widen to `… | undefined` and fail to match fate's shape.

```ts
import type {SourceRegistry} from "@nkzw/fate/server";

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

`genEffect` is `Effect.gen(body) as Effect.Effect<A, unknown, R>` — the bridge's single contained boundary cast. The body is a `Generator<any, A, any>` whose `any` yield erases the env to `unknown`, so it is asserted to `R`. fate never sees a generator (its contract is `(args) => Promise<Output>`), so the cast is *reducible* in principle (pin `R` in the yield via `Effect.gen.Return`) — but `R` in the yield position is contravariant (a narrow-`R` body fails against the wider `FateEnv`) and the friction cascades into fate's `QueryDefinition<FateContext<WorkerFateServices>>` server constraint, so it is kept as one cast.

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
