# @kampus/fate-effect

Effect-native [fate](https://github.com/nkzw-tech/fate) integration — fate's structure with
Effect's semantics.

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

## What it is

Feature code keeps fate's record shapes (`queries` / `lists` / `mutations` / `sources` / views),
but every record entry pairs a **pure-data definition** (Effect Schema inputs, the success view,
a declared error union) with an **`Effect.fn` handler**. The types carry the contracts: an
unloadable source, an undeclared wire error, or a forgotten domain layer is a *compile* error,
not a runtime surprise.

Requests are served by a native Effect interpreter on the request fiber — no Effect→Promise hop
per request, sources batched per request (N+1 is structurally impossible), and one error codec
for the whole wire surface. The interpreter is verified **byte-equal** to fate's own server by a
differential oracle in this package's test suite.

The authoring surfaces, one line each (full detail in the module map below):

- **`FateWireCode`** (`WireError.ts`) — annotate a domain error and it becomes a wire error;
  `encodeWireError` is the one codec, there is no registry.
- **`FateDataView`** (`DataView.ts`) — the view class factory; its static `view` *is* the kernel
  data view. A field-map symbol slip loud-fails at construction instead of degrading to `never`
  far away.
- **`Fate.source`** (`Source.ts`) — per-entity loaders; handlers are plain generators wrapped in
  `Effect.fn`, batched per request.
- **`Fate.query` / `Fate.list` / `Fate.mutation`** (`Operation.ts`) — record entries keyed by
  wire name; inputs are decoded before your handler runs, declared errors are compile-checked.
- **`FateServer`** (`Server.ts`) — one config, one layer; config validation names every offender
  at layer build *and* at codegen, so a bad config fails `pnpm build`.
- **`CurrentUser` / `LivePublisher`** — the per-request pair; fresh values provided onto each
  handler from the request context.

## Why it exists

fate is the data layer phoenix's frontend already speaks (its protocol, its live wire), but its
semantics are Promise-shaped. This package keeps fate's structure so the client story stays
byte-compatible, and swaps the semantics to Effect so every contract a feature team cares about
— declared errors, required domain services, input decoding — moves from runtime surprise to
compile error. The v1 architecture decision is [ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md);
the native-interpreter cutover (v2 serves exactly what fate would, verified by the differential
oracle) is [ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md).

Scope boundary: this package owns the server/authoring substrate only — no HTTP routing (the
worker's route calls `FateInterpreter.handleRequest` inside its own handler), no database
clients (loaders receive your domain services), and no client bundle (codegen emits what the
fate Vite plugin consumes).

## How to use it

Depend on it via `workspace:*` and author four record kinds, then compose:

```ts
import {Fate} from "@kampus/fate-effect";

export const noteSource = Fate.source(NoteView, {id: "id"}, {
	byIds: function* (ids) {
		const notes = yield* Notes;
		return yield* notes.getByIds(ids);
	},
});

export const mutations = {
	"note.add": Fate.mutation(
		{input: AddNoteInput, type: NoteView, error: Schema.Union([Unauthorized, NoteNotFound])},
		Effect.fn("note.add")(function* ({input}) {
			/* ... */
		}),
	),
};

export const fateConfig = FateServer.config({queries, lists, mutations, sources: [noteSource]});
```

Serve it as one Effect on your request fiber — per request:

```ts
const context: FateRequestContext = {
	currentUser: {user: session?.user},
	livePublisher,
};
const response = yield* FateInterpreter.handleRequest(request, context);
```

Build-time client codegen needs the same config with inert handlers:

```ts
import {FateExecutor} from "@kampus/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
```

The full narrative walkthrough — building a `Note` entity end to end with real code — lives in
[WALKTHROUGH.md](./WALKTHROUGH.md). Per-topic pattern docs:
[data views](../../.patterns/fate-effect-data-views.md) ·
[sources](../../.patterns/fate-effect-sources.md) ·
[operations](../../.patterns/fate-effect-operations.md) ·
[wire errors](../../.patterns/fate-effect-wire-errors.md) ·
[server](../../.patterns/fate-effect-server.md) ·
[interpreter](../../.patterns/fate-effect-interpreter.md) ·
[compiler/codegen](../../.patterns/fate-effect-compiler.md) ·
[worker wiring](../../.patterns/fate-effect-worker-wiring.md) ·
[per-feature assembly](../../.patterns/per-feature-fate-aggregators.md)

## The rules, in one list

| Invariant | Enforced by |
| --- | --- |
| A source with no loader doesn't exist | type-level (`SourceLoaderContract`) |
| Loaders can't fail typefully; infra dies | the service-boundary die rule + `E = never` on handler slots |
| Undeclared wire errors don't compile | `E extends DefinitionErrors<D>` bound |
| Invalid input never reaches a handler | Schema decode in the entry's `resolve` |
| A missing domain layer doesn't compile | `FateServer.layer`'s `R` |
| Wire codes can't silently drift | per-feature enumeration pin tests |
| A field-map symbol slip loud-fails at view construction | `AssertFieldMapResolved` in `DataView.ts` (the #2805 class of silent `never`s) |
| A failed live publish can't fail a mutation | `LivePublisher` methods are `Effect<void>` |
| One Effect→Promise conversion in the package — the oracle baseline's runner in `Executor.ts`; the serving path converts at the platform edge, outside the package | an enumeration test source-greps `src/` for `run*` |
| v2 serves exactly what fate would | the differential oracle (byte-equal corpus, per-plane suites) |

## Module map

| Module | What it is |
| --- | --- |
| `WireError.ts` | `FateWireCode` annotation + `encodeWireError` (the one error codec) |
| `DataView.ts` | `FateDataView` class factory, `Entity<>`, `FateDataView.list`; the `AssertFieldMapResolved` loud-fail guard |
| `Source.ts` | `Fate.source` — per-entity loaders, span-named handlers |
| `Operation.ts` | `Fate.query` / `Fate.list` / `Fate.mutation` + `InputValidationError` |
| `Fate.ts` | the `Fate` authoring namespace (the constructors + `Entity` + `FateWireCode`; every member is also flat-exported) |
| `Server.ts` | `FateServer` tag, `config`, `layer`; config validation (shared with codegen, so a bad config also fails the build); the per-request provision seam ([ADR 0107](../../.decisions/0107-capability-authz-framework.md) §7) |
| `CurrentUser.ts`, `LivePublisher.ts` | the per-request pair (tags; values come from the host) |
| `RequestContext.ts` | `FateRequestContext` — the per-request contract (the pair as values; deliberately no `signal`) |
| `Provision.ts` | `provideRequestPair` — the one per-request provision pipeline (request values innermost, captured build-time services beneath) |
| `Protocol.ts` | the wire protocol as Effect Schema, drift-pinned against fate's types |
| `Interpreter.ts`, `Walk.ts`, `Connection.ts` | the native serving path: dispatch, selection walk with `RequestResolver` batching, pagination |
| `Executor.ts` | the frozen v1 compile step — the differential oracle's baseline only since the cutover (and the package's one `runPromise` conversion) |
| `Codegen.ts` | `toCodegenServer` — the build-time codegen surface (inert handlers; what `schema.ts` exports) |
| `Compiled.ts` | the compiled-definition internals `Executor.ts` and `Codegen.ts` share (so the two lifecycles never import each other) |

Decisions (the why): [ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md) (v1
architecture), [ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md)
(native interpreter cutover).

## Testing

```bash
pnpm --filter @kampus/fate-effect test        # vitest run
pnpm --filter @kampus/fate-effect typecheck   # tsc -p tsconfig.json
```

The suite carries the differential oracle (the interpreter must serve byte-equal to fate's own
server across the corpus), type-level pin tests (client types identical between live server and
codegen server), and the enumeration tests behind the rules table above.
