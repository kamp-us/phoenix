# fate-effect compiler — `FateExecutor`: config → pure `createFateServer` (oracle baseline + codegen)

How `@phoenix/fate-effect` turns a composed `FateServer` into fate's own server value (the v1 backend, PRD stories 8/11). **Since the v2 cutover (ADR 0043) this path serves nothing**: the `/fate` route runs the native interpreter ([fate-effect-interpreter.md](./fate-effect-interpreter.md)). The compile step survives with exactly two roles:

- **The differential oracle's baseline** — `Interpreter.test.ts` byte-compares the interpreter against fate's real `createFateServer` over these compiled executors (including the walk-baseline rigs over `compileFateSources`). The oracle is the regression net, so the v1 side stays exactly as it served.
- **The build-time codegen surface** — `toCodegenServer` (below) is what `schema.ts` exports for Vite codegen; the output is a **real fate server** value, so the client manifest and `InferFateAPI` hold by construction.

Entries are authored per [fate-effect-operations.md](./fate-effect-operations.md) / [fate-effect-sources.md](./fate-effect-sources.md), composed per [fate-effect-server.md](./fate-effect-server.md).

## Wiring it (the oracle-harness shape)

```ts
import {FateExecutor, FateServer} from "@phoenix/fate-effect";
import {Layer, ManagedRuntime} from "effect";

// the baseline backend: one runtime over the config + domain layers
const runtime = ManagedRuntime.make(FateServer.layer(config).pipe(Layer.provide(domainLayers)));
const handleFate = FateExecutor.toFetchHandler(runtime);

// per request — the per-request pair as VALUES on ONE context object
const response = await handleFate(request, {
	currentUser: {user: session?.user},                       // CurrentUserInfo is a structural subset of the better-auth user
	livePublisher: livePublisherFor({publish, waitUntil}),    // worker-side live implementation (fate-effect-server.md)
	signal: request.signal,                                   // v1-path-only: abort interrupts the resolver fiber via runPromise
});
```

- `toFetchHandler(runtime)` resolves the `FateServer` service from the runtime on first call (config validation surfaces there), compiles **once**, and returns fate's `handleRequest` bound to the compiled server. `FateExecutor.compile(service, runtime)` is the pure construction underneath — the codegen comparisons read the live server's `manifest` through it.
- `FateExecutorRuntime` is `ManagedRuntime<FateServer, never>`; `ManagedRuntime` is contravariant in R, so a wider runtime satisfies it.

## What a compiled resolver does (the four-step pipeline)

For every `Fate.query`/`Fate.list`/`Fate.mutation` entry, the compiled fate resolver is:

1. **Decode** — the entry's `resolve` (built by the constructor) runs the definition's Schema before the handler; failures are the annotated `InputValidationError` (`VALIDATION_ERROR`, fate's own schema-failure code). The compiled mutation **never** populates fate's `input?: SchemaLike` slot — the decode already lives in `resolve`; a second validator would double-validate.
2. **Provide** — `CurrentUser` and `LivePublisher` are provided from the request context VALUES (innermost, so they always win), then the build-time services captured by `FateServer.layer` (`service.services`) underneath. This is the whole per-request story: no per-request layer, no runtime rebuild, no context smuggling.
3. **Run** — `runtime.runPromise` on the runtime, with the request's abort signal. This is the package's **single Effect→Promise conversion point** (effect-smol LLMS.md § "Integrating Effect into existing applications": fate's `(args) => Promise` resolvers are the non-Effect callback boundary `ManagedRuntime` targets) — oracle-baseline-only since the cutover: the SERVING path's conversion is the platform layer's, outside the package. Because the fiber starts from the runtime, the handler's `Effect.fn` span (wire name; `<Entity>.<capability>` for sources) nests under the runtime's ambient span if one is present — pinned in `Executor.test.ts` with a `Tracer.ParentSpan` collector.
4. **Encode failures** — the `Exit` is mapped once: declared annotated errors (and `InputValidationError`) go through `encodeWireError` keeping their wire code; defects collapse to `INTERNAL_SERVER_ERROR` + `"Something went wrong."` (details never reach the wire); a `FateRequestError` passes through verbatim. The thrown wire error is what fate serializes as `{ok: false, error: {code, message}}`.

## Sources

`compileFateSources(sources, {runtime, services})` builds fate's `{getSource, registry}`:

- **One registry Map, keyed by definition identity** — each entry's `definition` object IS the key (fate looks executors up by identity; `Fate.source` created the object once).
- Adapted handlers follow the executor contract: `byId({id})` → row-or-null, `byIds({ids})` → the rows that exist (`ReadonlyArray` re-spread into fate's mutable `Array`), `connection({cursor, direction, take, skip, plan})` → the package's page bag with `args` taken from `plan.args` (the scoped connection args). Source handlers run through the same provide/run/encode pipeline, so they may use the per-request pair too.
- `getSource` resolves a view **or** a definition by `typeName` to the same keyed object; an unknown entity throws with the name.

## The codegen server (`toCodegenServer` — build time, no database)

`FateExecutor.toCodegenServer(config)` is the **build-time** form of the same compile: the identical `createFateServer` call (same record keys, same `type` strings, same `roots: {}`, same `live` passthrough — so `manifest` deep-equals the live compiled server's) with every resolver and source executor **inert** (throws if executed). `schema.ts` exports it as `fateServer` for the fate Vite plugin's `runnerImport`:

```ts
// worker/features/fate/schema.ts (the task-9 shape; spike fixture: codegen-schema.fixture.ts)
export const termDataView = TermView.view;            // the plugin's schema walk picks up kernel views
export type Term = Fate.Entity<typeof TermView>;      // generated client imports types by manifest name
export const Root: Record<string, unknown> = {…};     // client root entries (annotated for nameability)
export const fateServer = FateExecutor.toCodegenServer(config);  // .manifest + InferFateAPI
```

- **It takes the TYPED config** (`FateServerConfig<Q, L, M, S>` — the value `FateServer.config` returns), not the erased service: the precise entry types are what the API types are computed from. The declared return type is `FateCodegenServer<Q, L, M>` — fate's server value carrying `FateCodegenAPI<Q, L, M>` as the `__api` phantom, so `InferFateAPI<typeof fateServer>` in the generated client resolves to it.
- **`InferFateAPI` fidelity holds, both directions** (the PRD's settled open question, pinned in `Codegen.test.ts`): `FateCodegenQueryApi`/`FateCodegenListApi`/`FateCodegenMutationApi` reproduce fate's own `QueryAPI`/`ListAPI`/`MutationAPI` mappings over the package's entry types. Client-facing `args`/`input` are the definition Schemas' **ENCODED** side (`DefinitionWireArgs`/`DefinitionWireInput`) — the wire contract: a `FiniteFromString` arg is `number` to the handler but `string` to the client. Outputs are the handlers' success types; mutation `entity` keeps the definition's literal type name. (The raw-record fallback arms left with the legacy arms at the v2 cutover — a non-entry maps to `never`, as fate's mapping does for an uninferrable record.)
- **Construction runs nothing.** Importing the schema module evaluates pure data — handlers are captured, never invoked (`Codegen.fixture.ts` proves it under a throw-on-touch Proxy database); no `ManagedRuntime`, no D1, no bindings at build time. The Vite-plugin end-to-end check lives in `apps/web/worker/features/fate/codegen-vite.test.ts` (a programmatic `vite build` through the plugin's real `runnerImport` path).
- **Validation parity**: the same `collectConfigIssues` walk `FateServer.layer` dies with runs here and **throws `FateServerConfigError` at build time** — duplicate wire names / missing sources fail the Vite build with the offenders named, before the worker ever boots.

## The erased→kernel boundary (the package's F7, contained)

The compiler works **type-erased**: composition correctness was already enforced where it is enforceable — handler definition sites typed their own R/E, `FateServer.layer`'s public R forced the domain layers, and the runtime could not exist without discharging them. Crossing back from the portable erased shapes (R at `unknown`; weak portable types because fate's `DataView` symbol trips TS2883 in exported configs) to fate's kernel types is a handful of **single named-type narrowings**, each one-directional-comparable, each marked `erased→kernel` in `Executor.ts`. Same contained-boundary precedent as `WireError.ts`'s protocol-code widening. The package pins the discipline in tests: no static `Effect.run*` anywhere in package sources, and the runtime promise runner appears exactly once, in `Executor.ts`.

## What not to do

- **Don't hand the definition's Schema to fate's `input?: SchemaLike` slot.** The decode lives in the entry's `resolve`; a second validator double-validates and forks the error shape.
- **Don't run resolvers with static `Effect.run*` or a second runtime.** One conversion point in the package (`Executor.ts`, oracle-baseline-only) — the enumeration test in `Executor.test.ts` fails on any new runner call site.
- **Don't rebuild source definitions.** The registry is identity-keyed; a fresh `{id, view}` object is an executor fate can never find.
- **Don't copy or spread the adapterContext into a new ctx object.** The per-request contract is object identity — the compiled `context` factory must keep returning the object it was handed.
- **Don't dispose the worker's runtime per request (or at all, on CF).** ADR 0041: isolates have no shutdown hook; the init-built runtime lives for the isolate. The Node test harnesses DO dispose per test/op — that's the harness lifecycle, not production's.
- **Don't wire this path back into the route.** The serving path is the interpreter (ADR 0043); `toFetchHandler` exists for the oracle. If the oracle and the interpreter disagree, the oracle wins until the divergence is understood and pinned.
