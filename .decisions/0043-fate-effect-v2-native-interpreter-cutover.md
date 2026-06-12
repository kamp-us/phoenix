---
id: 0043
title: fate-effect v2 — the native interpreter serves /fate; no runtime on the request path
status: accepted
date: 2026-06-10
tags: [fate, effect, architecture, observability, framework]
---

# 0043 — fate-effect v2: the native interpreter serves `/fate`; no runtime on the request path

## Context

ADR 0042 shipped fate-effect v1: feature records authored as `Fate.*` entries, compiled by
`FateExecutor` into a real `createFateServer` value, served through fate's own `handleRequest`
with every resolver running across an Effect→Promise hop on the one worker-level
`ManagedRuntime` (ADR 0041). It also named v2: reimplement fate's request loop as a native
Effect program and retire the compiled path from serving.

Tasks 14–16 built that native plane inside `@phoenix/fate-effect` under a **differential
oracle**: `FateInterpreter.handleRequest` (protocol codecs in `Protocol.ts`, dispatch loop in
`Interpreter.ts`, the byId selection walk over `RequestResolver`-batched sources in `Walk.ts`,
the connection plane in `Connection.ts`) proved byte-equal to the v1 compiled server across the
full operation surface — every operation kind, every migrated feature's shapes, success and
error paths, cursor round-trips, publish parity. This ADR records the cutover that makes the
interpreter the serving path.

## Decision

### The route serves the interpreter on the request fiber

`POST /fate` (`worker/features/fate/route.ts`) yields `FateInterpreter.handleRequest(raw, ctx)`
directly — it is an `Effect<Response, never, FateServer>`, so the route handler simply runs it
as part of its own per-request program. There is **no ManagedRuntime on the request path** and
no Effect→Promise conversion inside the worker: the platform layer (alchemy's worker bridge
running the compiled `HttpRouter.toHttpEffect`) owns the single run boundary for the whole HTTP
surface, exactly as it already did for every other route.

The `FateServer` service reaches the route the same way the worker singletons do: the
init-built runtime's context layer (`makeFateRuntime`'s `contextLayer`, now
`Layer<WorkerFateServices | FateServer>`) discharged per request by
`HttpRouter.provideRequest` (`http/app.ts`). The isolate-level `ManagedRuntime` survives as
**init-only wiring** — the lazy layer-build/memoization vehicle behind that context layer (the
no-init-warmup rule from ADR 0041 still applies: nothing async in isolate init scope). The T2
harness (`run-fate-op.ts`) also serves through the interpreter, with a per-op disposed runtime
as its Node-side run vehicle.

### Abort → interruption is wired at the route edge

v1 passed `{signal}` to `runtime.runPromise`. The interpreter deliberately leaves interruption
to the caller, and alchemy's worker bridge runs the request fiber with `Effect.runPromiseExit`
and **no signal wiring** — so the route owns it: `interruptOnAbort(raw.signal)` (exported from
`route.ts`, T0-tested) forks the interpreter program as a child of the request fiber and
interrupts it from the signal's `abort` listener — the same mechanism effect-smol's own
platform handler uses (`HttpEffect.toWebHandlerWith`: `request.signal` listener →
`fiber.interruptUnsafe()`). `FateRequestContext.signal` stays only for the v1 compile path (the
oracle baseline); the route no longer sets it.

### Observability without the explicit runtime

Because the program runs on the request fiber, every handler/source `Effect.fn` span parents to
the router's request span (the `HttpEffect.toHandled` tracer middleware) — including source
loads through the walk's `RequestResolver` batch fiber. Pinned in `Interpreter.test.ts`
("observability": operation + batched-source spans parent to the ambient request span, never a
detached root). This strictly improves on v1, where resolver fibers started from the runtime
and only nested under a request span if the runtime context carried one.

### What remains of the compile path, and why

- **`FateExecutor.compile`/`toFetchHandler` are KEPT as the differential oracle's baseline.**
  The oracle (`Interpreter.test.ts`) is the regression net for the native plane — it
  byte-compares the interpreter against fate's real `createFateServer` over the compiled
  executors (including the `makeWalkV1`/`makeFxWalkV1` walk-baseline rigs riding
  `compileFateSources`). The package's one `runtime.runPromise` conversion point therefore
  stays in `Executor.ts`, oracle-baseline-only; the enumeration test's rationale was updated,
  teeth unchanged.
- **`toCodegenServer` is the build-time surface, untouched.** `schema.ts` exports it for Vite
  codegen (inert handlers, no database, build-time config validation). Codegen output across
  the cutover: byte-identical.
- **The raw legacy arms are REMOVED** (0042's removal slate, due here): `RawFateOperation`,
  `RawFateSourceEntry`, the `Executor.ts` legacy passthroughs (`legacyQuery`/`legacyList`/
  `legacyMutation`/`toKernelExecutor`), the interpreter/walk fail-closed raw arms, and the
  codegen API types' raw fallback arms. The config records now accept only constructor-built
  entries. `AnyFateSourceEntry` with empty handlers (`handlers: {}`) keeps working — the
  capability-less escape hatch (`contributionSource`) is not a raw arm.

### The byId divergence goes live (user-visible behavior change)

fate populates `sourcesByType` only by visiting root views; v1 compiles with `roots: {}`
(ADR 0016/0019), so the v1 server answered **every** `kind: "byId"` operation `NOT_FOUND` —
dead code, despite registered sources. The interpreter resolves byId from `config.sources`
directly. fate's client CAN emit byId (cache-miss node fetches, missing-field refetches, the
`fetchLiveRecord` live-payload fallback), so **at cutover that traffic goes error→data**:
strictly additive on the wire, and it fixes a latent live-refetch breakage (a live event whose
payload didn't cover the selection used to dead-end in NOT_FOUND). Recorded as a deliberate,
pinned non-parity (`Interpreter.test.ts`), not an accident.

## Consequences

- One serving stack: decode → dispatch → encode as Effect end to end; fate's kernel runs
  nothing at request time. fate's only runtime zod left the execution path with task 16.
- The request path holds zero type assertions and no runtime; the erased→kernel narrowings
  remain documented seams inside the package.
- The v1 path's maintenance cost is scoped to the oracle: if fate's wire protocol moves, the
  drift pin + oracle fail loudly; the baseline is updated with the pin.
- Cutover evidence: full T0–T2 (package 129, web unit 139) green, codegen diff byte-empty, and
  the complete `apps/web` integration suite (T3, deployed workerd) green post-swap.

## Reconciliation

- **ADR 0041** (one worker-level ManagedRuntime): **amended-in-part** — the runtime doctrine
  ("no per-request runtime, one isolate-level construction, never disposed") survives; its
  serving role (every resolver runs through it; the F4 span argument) is retired with the
  compiled path. The runtime is now init-only wiring for the route context layer.
- **ADR 0042**: **amended-in-part** — v1 architecture stands as history; "toFetchHandler is the
  worker-facing form" and the raw-arm removal slate are superseded by this ADR.
- ADR 0016/0019 (no roots; resolver-owned reads): unchanged — and now load-bearing for the byId
  divergence framing above.
- ADR 0027 (HTTP rides HttpRouter): reinforced — `/fate` is now an ordinary route handler.
