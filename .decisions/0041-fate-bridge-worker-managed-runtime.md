---
id: 0041
title: fate↔Effect bridge — one worker-level ManagedRuntime (F4), the LLMS-documented integration pattern
status: accepted
date: 2026-06-07
tags: [effect, runtime, worker, fate, observability, framework]
---

# 0041 — fate↔Effect bridge: one worker-level ManagedRuntime (F4)

## Context

The fate↔Effect bridge (`apps/web/worker/features/fate/effect.ts`) is the seam
where protocol-neutral Effect domain services (Sozluk, Pano, Vote, Pasaport,
Stats) meet fate's `(args) => Promise<Output>` resolver callbacks. An adversarial
Effect-idiom audit filed it with finding **F4 — resolvers run on the empty
default runtime**.

[0029](0029-worker-runtime-servicemap.md) dissolved the per-request
`ManagedRuntime` from [0017](0017-hono-route-owns-fate-runtime.md): the binding
model changed (`Cloudflare.D1Connection.bind` resolves once per isolate), so the
service graph is isolate-stable and a runtime-per-request was no longer needed to
hang it on. That removal was correct. But 0029 replaced the per-request runtime
with `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` on Effect's
**default** runtime, carrying only a captured `Context` (services, no FiberRefs).
0029 even flagged the consequence in its own prose: *"if a Tracer/logger is ever
installed at worker scope, the bridge must re-establish the span/logger —
otherwise resolver spans would be detached roots."*

That hypothetical is the live defect. Each resolver's `Effect.withSpan` opens a
**detached root span** instead of nesting under a request span; the ~59
`Effect.fn` spans across the domain services are effectively inert (a trace is
~59 unparented roots, not one tree), and the default runtime carries no
scheduler / FiberRefs / interruption from the request. The seam pre-spent its
observability budget.

The diagnosis: **0029 over-corrected.** The answer to "a runtime per request is
wrong" is not *zero runtimes* (run on the default runtime, lose span nesting) and
not *a runtime per request* (the lifecycle 0017 had). It is **one worker-level
runtime**, built once per isolate, that every resolver runs through.

## Decision

**Build one `ManagedRuntime` per isolate and run every resolver through it.**

- The worker constructs **one** `ManagedRuntime.make(workerLayer, {memoMap})` at
  isolate init in `index.ts`. `workerLayer` is the **zero-arg** `makeFateLayer`
  (`Layer<WorkerFateServices, never, Database | BetterAuth>`, per
  [0040](0040-testing-taxonomy-and-seam-graduation.md)) with `Database` and
  `BetterAuth` provided. A shared `Layer.makeMemoMapUnsafe()` is passed as
  `memoMap` so memoization holds across the runtime and any route-context layer
  derived from the same built context.
- The bridge runs each resolver through that runtime:
  `ctx.runtime.runPromiseExit(effect.pipe(Effect.provideService(Auth, ctx.auth), Effect.provideService(LiveBus, ctx.liveBus)), {signal: ctx.request.signal})`.
  `Auth` and `LiveBus` are per-request **values** provided onto each resolver
  effect — not baked into the isolate-level runtime. The `{signal}` propagates a
  client abort to the resolver fiber. This is the single place `runPromiseExit`
  appears in the bridge.
- Because the resolver fiber starts from the worker-level runtime (not the
  default runtime), a resolver's `Effect.withSpan` **nests under the runtime's
  request span** — `span.parent` is `Some`, the trace is one tree. **F4 is
  fixed.**
- `FateContext<R = WorkerFateServices>` now carries
  `{runtime, request, auth, liveBus}` (a `ManagedRuntime`, no longer a captured
  `Context`), generic in `R` so the isolation tests can drive a marker runtime.

This is the inverse of 0029's "the bridge changes exactly one line" claim:
0029's one-line change to the default runtime is what introduced F4, and 0041
moves that one line back onto a runtime — but a **worker-level** one, keeping
0029's correct insight that the runtime is built once per isolate, not per
request.

## Conformance with effect-smol LLMS.md

Per the project rule (ground Effect API/design decisions in effect-smol's
`LLMS.md` over intuition), this is the documented integration pattern, not a
local invention. effect-smol's `LLMS.md`, section **"Integrating Effect into
existing applications,"** states that `ManagedRuntime` bridges Effect programs
with non-Effect code: build one runtime from your application `Layer`, then use
it anywhere imperative execution is needed — web handlers, framework hooks,
worker queues, or legacy callback APIs. The worked example, **"Using
ManagedRuntime with Hono"** (`ai-docs/src/03_integration/10_managed-runtime.ts`,
repo-relative within effect-smol), is exactly this shape: a single
`Layer.makeMemoMapUnsafe()`, one `ManagedRuntime.make(layer, {memoMap})`, and
`runtime.runPromise*` called from the framework's `(c) => Promise` handlers — and
notes the same pattern works for Express, Fastify, Koa, and other frameworks.

fate's resolvers are `(args) => Promise<Output>` callbacks; fate is the external
framework, like Hono. So the LLMS-sanctioned bridge for this boundary **is** a
single shared `ManagedRuntime` whose `runPromise*` is invoked from the
framework's callbacks. That is the design.

### Platform deviation — CF Workers never dispose (grounded, not preference)

The LLMS "Using ManagedRuntime with Hono" example disposes the runtime on
`SIGINT`/`SIGTERM`. **Cloudflare Workers have no process shutdown hook** — an
isolate is torn down without a signal, so a `process.once("SIGINT", …)`
disposal path can never run. phoenix therefore builds the runtime once at
isolate init and **never disposes it**: it lives for the isolate's lifetime, and
`Drizzle`-over-D1 holds no poolable socket or external connection, so there is
nothing to release at teardown. This is the single justified deviation from the
documented example, and it is a real platform constraint (no shutdown hook), not
a preference.

## Framework-and-app graduation (ADR 0040)

phoenix is the framework and its first app simultaneously. The worker-level
`ManagedRuntime` bridge is a **framework seam, born in-app** (0040's
organic-evolution lens):

- It is documented as a framework **pattern**
  ([.patterns/fate-effect-bridge.md](../.patterns/fate-effect-bridge.md),
  [.patterns/alchemy-runtime.md](../.patterns/alchemy-runtime.md)) so the next
  feature inherits the LLMS-sanctioned integration idiom rather than reinventing
  it.
- It stays **app-local under `worker/`**. ADR 0040's **Gate B** (graduation to
  `packages/` — requires proven-in-app *and* a second consumer or an upstream
  home) is **not met**: one consumer, no upstream home. Recorded explicitly so a
  future agent does not prematurely extract it. (The `runFateOp` test runner is
  likewise a framework test-primitive kept app-local — Gate A satisfied, Gate B
  not.)

## F7 — the `genEffect` env-channel cast is permanent

`genEffect` keeps its single `as Effect.Effect<A, unknown, R>` cast. This is
**permanent**, not a deferred cleanup, for two structural reasons proven in the
origin session (removing the cast broke typecheck twice):

1. **`E = never` rejects every failing resolver.** Pinning via
   `Effect.gen.Return<A, never, R>` makes the error slot `never`, so a resolver
   that can fail (`DrizzleError`, `Unauthorized`) reports "Missing errors."
2. **`R` is contravariant in the generator yield position.** A narrow-`R` body
   (`yield* Sozluk`) fails against the wider `FateEnv`, cascading into fate's
   `QueryDefinition<FateContext<WorkerFateServices>>` server constraint.

It is a plain `as` (not the banned `as any` / `as unknown as`); bodies are still
type-checked at their definition sites, and a wrong env surfaces at runtime as
"service not found," not a silent miss. **Do not re-litigate.**

## Alternatives considered

**Captured-context `runPromiseExitWith(ctx.context)` runner (not chosen).** An
earlier PRD draft chose a captured-context `runPromiseExitWith` runner to get
per-request span nesting while avoiding a shared isolate-level scope. It is
valid — it is the lower-level primitive that `ManagedRuntime.runPromiseExit` uses
*internally* — but it is **not** the integration pattern LLMS.md documents, and
choosing it was intuition over the documented idiom. Per the project rule, the
documented `ManagedRuntime` integration pattern wins; this is recorded as
considered-not-chosen.

## Out of scope

- **F1 / F2 / F3 / F5 / F6** — the function-DI → static-graph-DI spine refactor
  (declare `R`, one static graph; the un-run-`Effect` auth typing; the `any` in
  `betterAuthLayer`'s requirements channel; `Layer.succeed`-rewrapping a resolved
  singleton; `Effect.cached` as cross-request dedup). These are a separate future
  refactor with its own ADR; the **three spikes** from the origin session are its
  future evidence base. F2's inert-stub guard (`pasaport-from-tag.test.ts`) holds
  the line in the meantime.
- **Graduating the bridge / `runFateOp` to `packages/`** — Gate B unmet (above).
- **The `/fate/live` SSE transport** (LiveDO fan-out) — not a resolver path; the
  runner change covers data queries / lists / mutations / sources. `LiveBus`
  publish is provided per-request and exercised by the isolation suite.

## Reconciliation

- **[0017](0017-hono-route-owns-fate-runtime.md)** (per-request runtime, disposed
  in `finally`) — stays superseded by 0029; 0041 does not revive the per-request
  lifecycle, only the *one* worker-level runtime.
- **[0029](0029-worker-runtime-servicemap.md)** — its worker-level-singletons /
  no-per-request-runtime / nothing-to-dispose insight is **retained**. Its
  specific choice to run resolvers on the **default** runtime with a captured
  `Context` is **superseded by this ADR** (it produced F4). 0029's Consequences
  are amended with a superseded-by-0041 note.
- **[0033](0033-mutual-do-layer-cycle-per-call-resolution.md)** (retired by 0037)
  — unaffected; the DO sibling-resolution concern is orthogonal to the resolver
  runtime.
- **[0039](0039-livebus-context-service.md)** — **reinforced.** 0039 established
  that `LiveBus` is acquired in Effect-world (`yield* LiveBus`) because mutation
  resolvers run inside `Effect.gen` with the full `FateEnv` provided by the
  bridge's `runEffect`. 0041 keeps that exact contract: `LiveBus` (and `Auth`) are
  provided per-request onto each resolver effect before it runs through the
  worker-level runtime, so 0039's "acquire it in Effect-world, no ALS" holds.
- **[0040](0040-testing-taxonomy-and-seam-graduation.md)** — its
  `.patterns/effect-testing.md` reference describes `runFateOp` as owning the
  "single-`provide` contract." Under 0041 that becomes the single-`provide` +
  worker-level-runtime contract: `runFateOp` builds the test `ManagedRuntime`
  internally (one owner of runtime construction + the live-bus stub). 0040's
  zero-arg `makeFateLayer` and `Database` seam are the layer this runtime is built
  from. The pattern-doc line stating "no `ManagedRuntime`" is corrected to "no
  *per-request* runtime, one *worker-level* runtime" in task 6.

Builds on [0029](0029-worker-runtime-servicemap.md),
[0039](0039-livebus-context-service.md),
[0040](0040-testing-taxonomy-and-seam-graduation.md).
