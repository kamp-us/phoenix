# Modular Durable Objects with per-call sibling resolution

The canonical phoenix shape for a Durable Object that needs to reach a
**sibling DO co-hosted on the same Worker**. The case covered here is the
one that has to be authored carefully: two DOs reference each other
(`ConnectionDO` ↔ `TopicDO`), Init-binding the sibling produces a
circular Layer dependency, and the fix is to push the sibling Tag onto the
RPC method's `R` channel instead of the Layer's requirements channel.

This pattern is the live-fan-out pair's actual implementation. Read
[ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)
for the type-system reasoning, then [ADR 0028](../.decisions/0028-effect-durable-object-model.md)
for the inline-form precedent. This doc is the working recipe.

## When to use this vs the simpler inline form

- **Single DO, no sibling references.** Inline form is fine —
  `Cloudflare.DurableObjectNamespace<Self>()("Name", Effect.gen(...))`
  with the body declared in-place. No need to split class from Layer.
- **Two co-hosted DOs that reference each other.** Modular `.make()` form,
  with sibling resolution per RPC call. The split is what makes the Layers
  compose without a cycle.

`ConnectionDO` and `TopicDO` use the modular form
(`apps/web/worker/features/fate-live/connection-do.ts`,
`apps/web/worker/features/fate-live/topic-do.ts`). They are currently phoenix's only
DOs; if a third DO lands with no sibling references, write it inline.

## The shape

The DO splits into three pieces:

1. **The RPC surface type** — what callers (sibling DOs or worker code)
   reach across the stub. `R` is `never` for methods that don't resolve a
   sibling, and `Sibling | Cloudflare.Worker` for methods that do (alchemy
   provides both on the DO side from the worker's captured services).
2. **The class Tag** — `class Self extends Cloudflare.DurableObjectNamespace<Self, RpcSurface>()("Name") {}`
   with **no inline body**. The class is identity + the RPC contract; it
   pulls in no runtime code (the bundler tree-shakes `.make()` out of
   consumers that import only the class).
3. **The implementation Layer** — `export const SelfLive = Self.make(Effect.gen(function* () { ... }))`.
   Two-phase: outer `Effect.gen` is shared init (once per namespace),
   inner `Effect.gen` is per-instance (once per instance wake).

```ts
// features/fate-live/connection-do.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import TopicDO from "./topic-do.ts";
import {makeConnectionInstance, type ConnectionInstance, type TopicRpc} from "./live-instance.ts";

// (1) RPC surface. `subscribe`/`unsubscribe` resolve the sibling per call,
// so they carry `R = TopicDO | Cloudflare.Worker`. `deliver`/`probe`
// resolve nothing, so they stay `R = never`.
export type ConnectionRpcSurface = Pick<
  ConnectionInstance<TopicDO | Cloudflare.Worker>,
  "subscribe" | "unsubscribe" | "deliver" | "probe"
>;

// (2) Class Tag — identity + contract, no body.
export default class ConnectionDO extends Cloudflare.DurableObjectNamespace<
  ConnectionDO,
  ConnectionRpcSurface
>()("ConnectionDO") {}

// (3) Implementation Layer.
export const ConnectionDOLive = ConnectionDO.make(
  Effect.gen(function* () {
    // ── SHARED INIT (once per namespace) ──
    // Do NOT resolve the TopicDO sibling here. `yield* TopicDO` in init
    // pins the Tag onto this Layer's requirements → circular Layer
    // dependency with TopicDOLive.
    //
    // The shared-init gen RETURNS the per-instance Effect (run once per
    // instance wake). `return yield*` would run per-instance setup during
    // shared init and break the two-phase DO model — so the nested Effect
    // is intentional here.
    return Effect.gen(function* () {
      // ── PER-INSTANCE (once per instance wake) ──
      const state = yield* Cloudflare.DurableObjectState;
      const instance = makeConnectionInstance(
        state,
        (topicKey): Effect.Effect<TopicRpc, never, TopicDO | Cloudflare.Worker> =>
          // Per-call sibling resolution. The Tag requirement lands on the
          // RPC method's `R`, not the Layer's init requirements — alchemy
          // provides it from the DO's captured services at invocation.
          Effect.map(TopicDO, (topics) => topics.getByName(`topic:${topicKey}`)),
      );
      return {
        fetch: /* SSE upgrade, request-shaped */,
        subscribe: instance.subscribe,
        unsubscribe: instance.unsubscribe,
        deliver: instance.deliver,
        probe: instance.probe,
      };
    });
  }),
);
```

## Two-phase init: why `return yield*` is wrong in the outer gen

The `.make()` body is a two-phase Effect:

- **Outer `Effect.gen`** runs **once per namespace** — alchemy invokes it
  to build the namespace's shared state. The outer body **returns the
  inner Effect** (an `Effect.Effect<RpcSurface, never, DurableObjectServices>`).
- **Inner `Effect.gen`** runs **once per instance wake** — alchemy invokes
  it when an instance is hydrated, yielding `Cloudflare.DurableObjectState`
  and building the per-instance closure (the RPC handlers).

`return Effect.gen(...)` returns the inner Effect as a value, leaving it
unrun. `return yield* Effect.gen(...)` runs the inner Effect inside the
outer one, which collapses the two phases: per-instance setup happens
during shared init, which is the wrong lifecycle. The biome diagnostic
`effect/returnEffectInGen:off` exists to suppress the linter here, because
this is one of the rare places where returning an unrun Effect from a
generator is the correct shape. Annotate the suppression with **why** so
the next agent doesn't "fix" it.

## Per-call sibling resolution

Inside the RPC method body, `Effect.map(SiblingTag, s => s.getByName(...))`
(or `yield* SiblingTag`) resolves the sibling and pushes the Tag onto the
method's `R`. The method signature becomes `Effect.Effect<A, E, Sibling | Worker>`.

Two seams discharge this `R`:

- **DO-side invocation** — when alchemy invokes the method on the DO
  instance, it provides the DO's own captured services (the sibling Tag,
  the `Worker` binding service, the per-instance `DurableObjectState`,
  etc.). The method's `R` is satisfied automatically.
- **Worker-side invocation** — when the worker calls `connection.subscribe(...)`
  through its `LiveConnections` handle, the worker's init phase has
  already yielded both DO Tags and holds them in `Effect.context()`. The
  call site does `.pipe(Effect.provide(workerContext))` to discharge the
  `R`. See the `liveLayer` block in `apps/web/worker/index.ts` for the
  worker-side seam.

Neither seam needs a cast. The Layer requirements stay clean:

```
ConnectionDOLive: Layer<ConnectionDO, never, Worker>
TopicDOLive:     Layer<TopicDO, never, Worker>
Layer.mergeAll(ConnectionDOLive, TopicDOLive): Layer<ConnectionDO | TopicDO, never, Worker>
```

No `Sibling` in the requirements channel; the worker provides `Worker` to
itself; the merged Layer composes. Init-binding the sibling would have
produced `Layer<…, …, Worker | Sibling>` for each, and the merge wouldn't
satisfy itself.

## Where the body actually lives

The closure that holds the per-instance state (the SSE queue, the
subscription map, the `epoch` cache) lives alongside the `.make()` Layer
in each DO file — `makeConnectionInstance` next to `ConnectionDOLive` in
`apps/web/worker/features/fate-live/connection-do.ts`, and
`makeTopicInstance` next to `TopicDOLive` in
`apps/web/worker/features/fate-live/topic-do.ts`. The `.make()` body
resolves the sibling namespace, builds the resolver thunk
(`(key) => Effect.map(Tag, …)`), and hands the state + resolver to the
factory. The factory returns the RPC handlers. The shared cross-DO RPC
types (`ConnectionRpc`, `TopicRpc`) live in `./protocol.ts` so both DOs
import them from one neutral place.

This split keeps the algorithm in a place a plain node-pool unit test can
drive without workerd — the factory takes a `DurableObjectState["Service"]`
and a sibling resolver; a test can inject fakes for both. See
`features/fate-live/do.test.ts` for the unit-test driver and
`tests/integration/fate-live.test.ts` for the black-box-over-HTTP version.

## Cross-references

- The same pattern in modular form lives as the `tagged-rpc-do` test
  fixture in alchemy-effect's package tests. That fixture is the upstream
  reference for the modular DO shape; phoenix's `ConnectionDO` / `TopicDO`
  pair are the production usage.
- [alchemy-durable-objects.md](./alchemy-durable-objects.md) — the
  broader DO surface (RPC vs `fetch`, `state.storage.sql`, alarms,
  hibernation). That doc covers everything the modular form has in
  common with the inline form; this doc is the sibling-pair specialization.
- [ADR 0028](../.decisions/0028-effect-durable-object-model.md) — the
  inline-form precedent and the "never resolve sibling in init" rule
  this doc restates against `.make()`.
- [ADR 0033](../.decisions/0033-mutual-do-layer-cycle-per-call-resolution.md)
  — the Layer-type proof of the cycle.
- [ADR 0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) — the
  upgrade that retired the `as never` sibling cast (modular form replaces it).
