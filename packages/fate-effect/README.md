# @kampus/fate-effect

Effect-native [fate](https://github.com/nkzw-tech/fate) integration — fate's structure with
Effect's semantics. Phoenix's domain↔protocol seam: feature code keeps fate's record shapes
(`queries` / `lists` / `mutations` / `sources` / views), and every record entry pairs a
**pure-data definition** (Effect Schema inputs, the success view, a declared error union) with an
**`Effect.fn` handler**.

```
defining things                 composing                serving
───────────────                 ─────────                ───────
FateWireCode (errors)  ┐
FateDataView (views)      │
Fate.source (loaders)     ├──►  FateServer.config  ──►  FateInterpreter.handleRequest
Fate.query / list /       │     FateServer.layer         (one Effect, request fiber)
Fate.mutation (resolvers) ┘            │
                                       └────────────►    FateExecutor.toCodegenServer
                                                          (build-time client codegen)
```

## Why it exists

The types carry the contracts, so the failure modes a hand-rolled data layer grows silently are
*compile* errors here:

- an unloadable source doesn't type (`SourceLoaderContract`),
- an undeclared wire error doesn't compile (`E extends DefinitionErrors<D>`),
- a forgotten domain layer doesn't compile (`FateServer.layer`'s `R`).

Requests are served by a native Effect interpreter on the request fiber — no Effect→Promise hop
per request, sources batched per request (N+1 is structurally impossible), one error codec for
the whole wire surface. The interpreter is verified **byte-equal** to fate's own server by a
differential oracle in this package's test suite. The why and history:
[ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md) (v1 architecture),
[ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md) (native interpreter
cutover).

**What this package is not:** not a general Effect HTTP framework (the host owns routing and
abort wiring); no client lives here — the SPA consumes generated types through
[react-fate](https://github.com/kamp-us/phoenix/blob/main/package.json). Authoring guidance lives
in the pattern docs, not here ([see below](#going-deeper)).

## How to use it

**Author entries** — errors carry a `FateWireCode`, views are `FateDataView` classes, sources are
`Fate.source(...)` loaders, operations are `Fate.query`/`list`/`mutation` definitions + handlers.
The recipes live in the pattern docs:
[data views](../../.patterns/fate-effect-data-views.md) ·
[sources](../../.patterns/fate-effect-sources.md) ·
[operations](../../.patterns/fate-effect-operations.md) ·
[wire errors](../../.patterns/fate-effect-wire-errors.md).
A start-to-finish guided build of one feature is at [walkthrough.md](./walkthrough.md).

**Guard view field maps against symbol slips.** A view whose kernel `view` recovery slipped
(renamed export, moved field map) fails loudly at the definition site when you assert it:

```ts
import {AssertFieldMapResolved} from "@kampus/fate-effect";
export const NoteView = AssertFieldMapResolved(NoteViewBase);
```

**Compose one config, one layer** — the package's only composition construct:

```ts
import {FateServer} from "@kampus/fate-effect";

export const fateConfig = FateServer.config({
	queries: panoQueries,
	lists: panoLists,
	mutations: panoMutations,
	sources: panoSources,
});
export const FateLive = FateServer.layer(fateConfig).pipe(Layer.provide(Pano));
```

Init-time validation runs against the same config the codegen imports, so a bad config also fails
the build ([server pattern](../../.patterns/fate-effect-server.md)).

**Serve per request** — one Effect on your request fiber; the interpreter owns no runtime and the
context deliberately carries no abort signal (the caller wires both):

```ts
import {FateInterpreter, type FateRequestContext} from "@kampus/fate-effect";

const context: FateRequestContext = {
	currentUser: {user: session?.user},
	livePublisher, // the worker builds this from its live topics + waitUntil
};
const response = yield* FateInterpreter.handleRequest(request, context);
```

See the worker's [route](../../apps/web/worker/features/fate/route.ts) for the
abort→interruption pattern.

**Generate client types at build time** — the same config with inert handlers, importable at
build time:

```ts
// schema.ts — the fate Vite plugin imports this via runnerImport
import {FateExecutor} from "@kampus/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
```

`InferFateAPI<typeof fateServer>` produces the same client types as the live server.

## Reference

**Live publish surface** — `LivePublisher` publishes three ways to a row and four to a
connection:

| Call | Tells subscribers |
| --- | --- |
| `live.update(type, id, {changed, data})` | here are these fields' new values |
| `live.delete(type, id)` | this row is gone |
| `live.invalidate(type, id)` | read this row again — no data attached |
| `live.topic(procedure, args).{appendNode,prependNode,deleteEdge,invalidate}(…)` | this connection's membership moved, or re-load it whole |

`invalidate` is the only honest repair for a **viewer-derived** field — one whose value depends on
who is reading. Its true new value differs per subscriber, so a broadcast payload would overwrite
every reader with the mutator's answer; attaching no data forces each subscriber to re-read on its
own viewer ([ADR 0314](../../.decisions/0314-entity-invalidate-frame-upstream.md)).

**Invariants, in one list**

| Invariant | Enforced by |
| --- | --- |
| A source with no loader doesn't exist | type-level (`SourceLoaderContract`) |
| Loaders can't fail typefully; infra dies | the service-boundary die rule + `E = never` on handler slots |
| Undeclared wire errors don't compile | `E extends DefinitionErrors<D>` bound |
| Invalid input never reaches a handler | Schema decode in the entry's `resolve` |
| A missing domain layer doesn't compile | `FateServer.layer`'s `R` |
| Wire codes can't silently drift | per-feature enumeration pin tests |
| A failed live publish can't fail a mutation | `LivePublisher` methods are `Effect<void>` |
| One Effect→Promise conversion in the package — the oracle baseline's runner in `Executor.ts`; the serving path converts at the platform edge, outside the package | an enumeration test source-greps `src/` for `run*` |
| v2 serves exactly what fate would | the differential oracle (byte-equal corpus, per-plane suites) |

**Module map**

| Module | What it is |
| --- | --- |
| `WireError.ts` | `FateWireCode` annotation + `encodeWireError` (the one error codec) |
| `DataView.ts` | `FateDataView` class factory, `Entity<>`, `FateDataView.list`, the `AssertFieldMapResolved` slip guard |
| `Source.ts` | `Fate.source` — per-entity loaders, span-named handlers; `syntheticSource` for non-table views |
| `Operation.ts` | `Fate.query` / `Fate.list` / `Fate.mutation` + `InputValidationError` |
| `Fate.ts` | the `Fate` authoring namespace (the constructors + `Entity` + `FateWireCode`; every member is also flat-exported) |
| `Server.ts` | `FateServer` tag, `config`, `layer`; config validation (shared with codegen, so a bad config also fails the build) |
| `CurrentUser.ts`, `LivePublisher.ts` | the per-request pair (tags; values come from the host) |
| `RequestContext.ts` | `FateRequestContext` — the per-request contract (the pair as values; deliberately no `signal`) |
| `Provision.ts` | `provideRequestPair` — the one per-request provision pipeline (request values innermost, captured build-time services beneath) |
| `Protocol.ts` | the wire protocol as Effect Schema, drift-pinned against fate's types |
| `Interpreter.ts`, `Walk.ts`, `Connection.ts` | the native serving path: dispatch, selection walk with `RequestResolver` batching, pagination |
| `Executor.ts` | the frozen v1 compile step — the differential oracle's baseline only since the cutover (and the package's one `runPromise` conversion) |
| `Codegen.ts` | `toCodegenServer` — the build-time codegen surface (inert handlers; what `schema.ts` exports) |
| `Compiled.ts` | the compiled-definition internals `Executor.ts` and `Codegen.ts` share (so the two lifecycles never import each other) |

## Testing

`pnpm --filter @kampus/fate-effect test` runs the suite: the differential oracle pinning the
interpreter byte-equal to fate's server (per-plane suites over a fixed corpus), type-level pins
for the codegen surface, enumeration tests that source-grep `src/` for wire-code and
conversion-drift drift. Typecheck: `pnpm --filter @kampus/fate-effect typecheck`.

## Going deeper

- Pattern docs (how to write feature code):
  [data views](../../.patterns/fate-effect-data-views.md) ·
  [sources](../../.patterns/fate-effect-sources.md) ·
  [operations](../../.patterns/fate-effect-operations.md) ·
  [wire errors](../../.patterns/fate-effect-wire-errors.md) ·
  [server](../../.patterns/fate-effect-server.md) ·
  [interpreter](../../.patterns/fate-effect-interpreter.md) ·
  [compiler/codegen](../../.patterns/fate-effect-compiler.md) ·
  [worker wiring](../../.patterns/fate-effect-worker-wiring.md) ·
  [per-feature assembly](../../.patterns/per-feature-fate-aggregators.md)
- Guided lesson: [walkthrough.md](./walkthrough.md) — one feature, end to end
- Decisions (the why): [ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md),
  [ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md)
