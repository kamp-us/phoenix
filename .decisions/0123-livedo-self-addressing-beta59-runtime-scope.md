---
id: 0123
title: LiveDO cross-role self-addressing on alchemy beta.59 — resolve the self-namespace at runtime, discharge the phantom Req leak
status: accepted
date: 2026-07-01
tags: [live, durable-objects, alchemy, effect]
---

# 0123 — LiveDO cross-role self-addressing on alchemy beta.59

## Context

Amends [0037](0037-unified-void-aligned-live-do.md)'s self-addressing section.
`LiveDO` is one Durable Object class in two roles (connection / topic); an
instance named `connection:<id>` must reach `topic:<key>` siblings of **its own
namespace**, cross-role, from the reusable `LiveDOLive` Layer. [0037](0037-unified-void-aligned-live-do.md)
did this cycle-free via `Cloudflare.DurableObjectNamespaceScope` — the local,
scriptName-less self-binding — which added no requirement, so the Layer was
`Layer<LiveDO, never, Worker>`.

The alchemy `2.0.0-beta.56 → beta.59` migration (epic #1610) is a ground-up
rewrite of `alchemy/Cloudflare`, and it **removed `DurableObjectNamespaceScope`**
(the local patch hunk that re-added it was dropped when re-keying to
`patches/alchemy@2.0.0-beta.59.patch`). Both obvious replacements fail, and ~211
residual typecheck errors all traced here:

- **Init-time `yield*` leaks a DO tag into the Layer `R`.** The beta.59 self-scope
  is `DurableObjectScope` (`Context.Service()("Cloudflare.DurableObject")`, Type
  `DurableObject<unknown>`; `alchemy/lib/Cloudflare/Workers/DurableObject.js:17`,
  `.d.ts:93`), yielded via `Cloudflare.DurableObject`. The **modular** `.make<Req>`
  signature (`DurableObject.d.ts`) is:

  ```
  make<Req = never>(
    impl: Effect<Effect<Shape, never, RuntimeContext | DurableObjectState | Scope>,
                 never, DurableObjectServices | Req>
  ): Layer<Self, never, Worker | Req>
  ```

  where `DurableObjectServices = DurableObject | DurableObjectState | WorkerServices
  | WorkerEnvironment | PlatformServices`. The self-scope service (`DurableObjectScope`)
  is **not a member of `DurableObjectServices`**, so a `yield* DurableObjectScope` in
  the outer init effect lands in `Req` — and `Req` propagates verbatim into
  `Layer<Self, never, Worker | Req>`, into `PhoenixLive`, into `apps/web/alchemy.run.ts`,
  whose `Alchemy.Stack` program is constrained to `StackServices | ProviderServices`
  and rejects a stray `DurableObject<unknown>`. That is the leak `.make` absorbs
  outer-init `DurableObjectServices` yields but **not** the self-scope.
- **`LiveDO.from(Self)` needs the host `Worker`.** The documented `.from(Self)` form
  binds the local namespace by passing the host worker, which `LiveDOLive` cannot
  import without a **worker↔DO import cycle** — the exact cycle the removed scope
  mechanism existed to avoid.

## Decision

Resolve the self-namespace **at per-instance runtime, not at Layer/stack build**,
and discharge the phantom `Req` leak with one localized type assertion. Grounded
against two authoritative sources.

1. **alchemy's circular-bindings guide** (https://v2.alchemy.run/guides/circular-bindings/):
   break a worker↔DO cycle by separating the class **Tag** (identity, import-free)
   from the **Layer** (`.make()` impl), and bind at runtime inside `.make()` — never
   import the host worker into the reusable Layer. phoenix keeps the `LiveDO` Tag
   import-free: `live-do.ts` imports no `Worker`/`worker/index.ts`, so `.from(Self)`
   (and its cycle) is never reached.
2. **beta.59's own self-namespace idiom.** `RpcDurableObjectScope`'s JSDoc: "yield it
   from within a DO handler to refer back to the surrounding namespace (e.g. to fan a
   call out to sibling instances) … **mirrors `yield* DurableObject` on the regular
   `DurableObject`**" (`RpcDurableObject.js:13`, `.d.ts` "Yielding the surrounding
   namespace"). So `yield* Cloudflare.DurableObject` **is** the author-intended
   self-namespace yield.

**Where the scope actually becomes available (why runtime, not build).** `.make`
resolves the local (scriptName-less) namespace handle `self = yield* binding()` and
provides it to the constructor: `impl.pipe(Effect.provide(Layer.succeed(DurableObjectScope,
self)))` (`DurableObject.js:640`). The bridge runs that constructor **per DO-instance
boot** under `blockConcurrencyWhile` (`DurableObjectBridge.js:34–36`), so the outer
init effect — which executes once per instance on the platform at runtime, **not** when
`LiveDOLive`/the `alchemy.run.ts` stack is built — has the scope in context and resolves
`self`, closing it over into the handlers. The inner, per-request handlers do **not**
get the scope: the bridge provides them `DurableObjectState + services` only, and
`services` was captured (`Effect.context()`) before the scope was provided — so the
yield **must** live in the outer init, closed into the handlers, never in a handler.

**The resolution in `LiveDOLive`.** Yield the self-namespace in the outer init and
discharge the phantom requirement:

```ts
const live = yield* (Cloudflare.DurableObject as unknown as Effect.Effect<LiveNamespace>);
```

The runtime yield is unchanged (alchemy still provides `DurableObjectScope` at
`DurableObject.js:640`); the assertion only erases the `Req` the `.make<Req>` type
fails to subtract. Result (type-probe verified): `LiveDOLive : Layer<LiveDO, never,
Worker>` — cross-role `connection:`↔`topic:` addressing intact, no DO tag in `R`, no
worker↔DO cycle.

**RuntimeContext coloring (a coupled beta.59 fact).** beta.59 colored DO
`state.storage` reads/writes and cross-role stub calls with `RuntimeContext`, so
`LiveRpcSurface`'s methods now carry `RuntimeContext` in their `R`. It is discharged
where the methods are actually invoked: at the worker call seam via
`Effect.provideService(RuntimeContext, runtimeContext)` (`worker/index.ts`), and in
the `do.test.ts` in-process unit runs via `RuntimeContext.phantom` — sound because the
KV-only `do-state` fake is pure `Effect.sync` and never reads the context.

## Consequences

- **The self-addressing pattern for a beta.59 DO addressing its own namespace from a
  reusable Layer:** keep the DO class Tag import-free; `yield* Cloudflare.DurableObject`
  in the **outer** init (never a handler); discharge the phantom `Req` with a single
  `as unknown as Effect.Effect<Namespace>` at the yield site, justified by the runtime
  provision at `DurableObject.js:640` that `.make<Req>`'s type does not model. This is
  the documented cost of the beta.59 typing gap — one localized assertion, not a
  structural change.
- **[0037](0037-unified-void-aligned-live-do.md)'s `DurableObjectNamespaceScope`
  bullet is superseded by this ADR** for the beta.59 substrate: the mechanism is gone;
  the "adds no requirement, so `R` is `never`" property is now achieved by the explicit
  discharge above, and the cross-role RPC methods' `R` is `RuntimeContext` (discharged
  at the call seams), not `never`. The one-class/two-role shape, KV storage, and the
  `generation`/`revision` stale model of [0037](0037-unified-void-aligned-live-do.md)
  all stand; the live SSE fan-out contract is preserved, not changed.
- **Scope boundary.** This ADR and its slice cover only the DO self-addressing leak.
  `alchemy.run.ts`'s residual `RuntimeContext` requirement traces to a **non-LiveDO**
  sub-layer (`EmailSenderLive`'s real ambient `yield* RuntimeContext`, plus the
  structural `Providers` the stack's providers config discharges) — the binding-model
  migration finished under epic #1610's child #1613, which is gated on this one.
- **Real-deploy proof is CI-gated.** The cross-role live SSE fan-out is only truly
  proven on a real Cloudflare deploy (typecheck-green ≠ deploy-green for the DO/SSE
  substrate); that verification rides the deploy CI job and the dedicated child #1615,
  not this typecheck/unit slice.
- See [alchemy-durable-objects.md](../.patterns/alchemy-durable-objects.md) (the unified
  DO recipe) and [fate-live-views.md](../.patterns/fate-live-views.md).
