# @kampus/fate-effect

Effect-native [fate](https://github.com/nkzw-tech/fate) integration — fate's structure with
Effect's semantics.

Feature code keeps fate's record shapes (`queries` / `lists` / `mutations` / `sources` / views),
but every record entry pairs a **pure-data definition** (Effect Schema inputs, the success view,
a declared error union) with an **`Effect.fn` handler**. The types carry the contracts: an
unloadable source, an undeclared wire error, or a forgotten domain layer is a *compile* error,
not a runtime surprise.

Requests are served by a native Effect interpreter on the request fiber — no Effect→Promise hop
per request, sources batched per request (N+1 is structurally impossible), and one error codec
for the whole wire surface. The interpreter is verified **byte-equal** to fate's own server by a
differential oracle in this package's test suite.

```
defining things                 composing                serving
───────────────                 ─────────                ───────
FateWireCode (errors)  ┐
FateDataView (views)      │
Fate.source (loaders)     ├──►  FateServer.config  ──►   FateInterpreter.handleRequest
Fate.query / list /       │     FateServer.layer         (one Effect, request fiber)
Fate.mutation (resolvers) ┘            │
                                       └────────────►    FateExecutor.toCodegenServer
                                                          (build-time client codegen)
```

## Getting started

The walkthrough builds one small feature — a `Note` entity with a read, a write, and a live
update. Every piece below is the real API; the in-repo worked example is sozluk
([views](../../apps/web/worker/features/sozluk/views.ts),
[sources](../../apps/web/worker/features/sozluk/sources.ts),
[queries](../../apps/web/worker/features/sozluk/queries.ts),
[mutations](../../apps/web/worker/features/sozluk/mutations.ts),
[errors](../../apps/web/worker/features/sozluk/errors.ts)).

### 1. Errors: one annotation, no registry

A domain error becomes a wire error by carrying a `FateWireCode` annotation. That's the whole
contract — `encodeWireError` reads the annotation at the boundary; there is no central registry
to keep in sync.

```ts
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class NoteNotFound extends Schema.TaggedErrorClass<NoteNotFound>()(
	"notes/NoteNotFound",
	{noteId: Schema.String, message: Schema.String},
	{[FateWireCode]: "NOTE_NOT_FOUND"},
) {}
```

Anything *without* an annotation (and any defect) maps to `INTERNAL_SERVER_ERROR` with a fixed
message — internals never leak onto the wire. Schema decode failures surface as the package's
own `InputValidationError` (`VALIDATION_ERROR`, fate's code for the same case).

### 2. Views: a class whose static `view` IS the kernel dataView

```ts
import {type Entity, FateDataView} from "@kampus/fate-effect";

type NoteRow = {id: string; title: string; body: string; authorId: string; createdAt: Date};

export class NoteView extends FateDataView<NoteRow>()("Note")({
	id: true,
	title: true,
	body: true,
	authorId: true,
	createdAt: true,
}) {}

export type Note = Entity<typeof NoteView, {createdAt: Date}>;
```

Two things worth knowing, neither of which you have to think about often:

- The `()("Note")` double call looks odd but is load-bearing: TypeScript has no partial type-
  argument inference, and this shape (the same one effect's `Schema.TaggedErrorClass<Self>()`
  uses) is what keeps the literal `"Note"` in your client types.
- `Entity<>`'s second parameter restates what the wire type widens: fate types `Date` row fields
  as `string` (the serialized form), so worker-side code that handles real `Date`s restates them,
  as above. Nested list relations need the same restatement (see sozluk's `Term`).

A relation is a field: `notes: FateDataView.list(NoteView, {orderBy: [{createdAt: "desc"}, {id: "asc"}]})`
inside another view's field map. Keep `orderBy` in lockstep with the SQL that pages it — that's
what makes keyset cursors round-trip.

### 3. Sources: how an entity loads (and batches)

A source pairs a view with loader capabilities. Handlers are plain generator bodies — the
package wraps them in `Effect.fn` and names the spans (`Note.byIds`) for you.

```ts
import {Fate} from "@kampus/fate-effect";
import {Notes} from "./Notes.ts"; // your domain service

export const noteSource = Fate.source(
	NoteView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const notes = yield* Notes;
			return yield* notes.getByIds(ids);
		},
	},
);
```

The loader contract lives in the types — at least one of `byId`/`byIds`, silent reads (absence
is `null`/fewer rows, not an error), `E = never` (infra failures die at the service boundary),
inferred requirements checked at composition (step 5). The full contract is the pattern doc's:
[sources](../../.patterns/fate-effect-sources.md).

At runtime, every ref to the same entity within one protocol request lands in **one** `byIds`
call, deduped — that's the interpreter's per-request batch window, and it's why `byIds` is
called "the relation workhorse".

### 4. Operations: definition + handler

Queries, lists, and mutations are record entries keyed by their wire names. The definition is
pure data; the handler is an `Effect.fn` whose span name is the wire name.

```ts
import {CurrentUser, Fate, LivePublisher, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

const AddNoteInput = Schema.Struct({title: Schema.String, body: Schema.String});

export const mutations = {
	"note.add": Fate.mutation(
		{
			input: AddNoteInput,
			type: NoteView,
			error: Schema.Union([Unauthorized, NoteNotFound]),
		},
		Effect.fn("note.add")(function* ({input}) {
			const user = yield* CurrentUser.required; // anonymous → UNAUTHORIZED
			const notes = yield* Notes;
			const live = yield* LivePublisher;

			const note = yield* notes.add({...input, authorId: user.id});

			// Live publish: error channel is `never` by construction — a failed
			// publish can never fail the mutation, and it never blocks the response.
			yield* live.connection("Notes.feed", {id: "all"}).appendNode("Note", note.id, {node: note});

			return note;
		}),
	),
};
```

What the types enforce here: the declared error union is checked at the constructor call (an
undeclared failure is a compile error), `input`/`args` are already decoded when the handler runs
(invalid input rejects as `VALIDATION_ERROR` before your code executes), and raw generators are
not accepted — `Effect.fn("<wire name>")` is the authoring form and names the trace span. The
full contract is the pattern doc's: [operations](../../.patterns/fate-effect-operations.md).
`CurrentUser` and `LivePublisher` are ordinary services from the handler's point of view; the
serving layer provides fresh per-request values.

Queries are the same minus `input`: `Fate.query({args: ArgsSchema, type: NoteView}, handler)`,
where the handler bag is `{args, select}` — `select` is the client's field selection, useful for
skipping expensive nested work (see sozluk's `term` query).

### 5. Compose: one config, one layer

```ts
import {FateServer} from "@kampus/fate-effect";

export const fateConfig = FateServer.config({
	queries,
	lists,
	mutations,
	sources: [noteSource],
});
```

```ts
import * as Layer from "effect/Layer";

// Layer<FateServer, never, R> where R = everything your handlers/sources need
// MINUS CurrentUser/LivePublisher (those are per-request values; the interpreter
// provides them onto each handler from the request context).
export const FateLive = FateServer.layer(fateConfig).pipe(
	Layer.provideMerge(NotesLive), // discharge domain services here
);
```

Composition is where the remaining contracts fire: a forgotten handler requirement is a
**compile error** at the `Layer.provide` site, and config validation (duplicate wire names,
view-reachable entities without a source) throws with every offender named — at layer build and
at codegen, so a bad config fails `pnpm build`. The validation list is the pattern doc's:
[server](../../.patterns/fate-effect-server.md).

### 6. Serve and generate

The serving path is one Effect — run it on your request fiber:

```ts
import {FateInterpreter, type FateRequestContext} from "@kampus/fate-effect";

// per request:
const context: FateRequestContext = {
	currentUser: {user: session?.user},
	livePublisher, // the worker builds this from its live topics + waitUntil
};
const response = yield* FateInterpreter.handleRequest(request, context);
```

The interpreter owns no runtime — the caller decides how the Effect runs (phoenix's worker
yields it inside its HTTP route; the test suite runs it through a `ManagedRuntime`). Abort
signals are likewise the caller's wiring — the context deliberately has no `signal` field
(the oracle baseline's `ExecutorRequestContext` is the one signal-bearing extension); see the
worker's [route](../../apps/web/worker/features/fate/route.ts) for the abort→interruption
pattern.

Client codegen needs the same config with **inert** handlers — no database, importable at build
time:

```ts
// schema.ts — the fate Vite plugin imports this via runnerImport
import {FateExecutor} from "@kampus/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
```

`InferFateAPI<typeof fateServer>` produces the same client types as the live server — pinned by
type-level tests in this package.

## The rules, in one list

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

## Module map

| Module | What it is |
| --- | --- |
| `WireError.ts` | `FateWireCode` annotation + `encodeWireError` (the one error codec) |
| `DataView.ts` | `FateDataView` class factory, `Entity<>`, `FateDataView.list` |
| `Source.ts` | `Fate.source` — per-entity loaders, span-named handlers |
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
- Decisions (the why): [ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md) (v1
  architecture), [ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md)
  (native interpreter cutover)
