# @phoenix/fate-effect

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
fateWireCode (errors)     ┐
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

A domain error becomes a wire error by carrying a `fateWireCode` annotation. That's the whole
contract — `encodeWireError` reads the annotation at the boundary; there is no central registry
to keep in sync.

```ts
import {fateWireCode} from "@phoenix/fate-effect";
import * as Schema from "effect/Schema";

export class NoteNotFound extends Schema.TaggedErrorClass<NoteNotFound>()(
	"notes/NoteNotFound",
	{noteId: Schema.String, message: Schema.String},
	{[fateWireCode]: "NOTE_NOT_FOUND"},
) {}
```

Anything *without* an annotation (and any defect) maps to `INTERNAL_SERVER_ERROR` with a fixed
message — internals never leak onto the wire. Schema decode failures surface as the package's
own `InputValidationError` (`VALIDATION_ERROR`, fate's code for the same case).

### 2. Views: a class whose static `view` IS the kernel dataView

```ts
import {type Entity, FateDataView} from "@phoenix/fate-effect";

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
import {Fate} from "@phoenix/fate-effect";
import {orDieDrizzle} from "../../db/Drizzle.ts";
import {Notes} from "./Notes.ts"; // your domain service

export const noteSource = Fate.source(
	NoteView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const notes = yield* Notes;
			return yield* notes.getByIds(ids).pipe(orDieDrizzle);
		},
	},
);
```

The loader contract lives in the types:

- **At least one of `byId`/`byIds` is required** — a source that can't load doesn't compile.
- **Absence is not an error**: `byIds` returns the rows that exist; `byId` returns `null`.
- **`E = never`**: loaders can't fail typefully. Infrastructure failures *die* (that's what
  `orDieDrizzle` does to the `DrizzleError` channel) and surface as `INTERNAL_SERVER_ERROR`.
- The service you `yield*` (here `Notes`) becomes part of the source's requirements and is
  checked at server composition (step 5).

At runtime, every ref to the same entity within one protocol request lands in **one** `byIds`
call, deduped — that's the interpreter's per-request batch window, and it's why `byIds` is
called "the relation workhorse".

### 4. Operations: definition + handler

Queries, lists, and mutations are record entries keyed by their wire names. The definition is
pure data; the handler is an `Effect.fn` whose span name is the wire name.

```ts
import {CurrentUser, Fate, LivePublisher, Unauthorized} from "@phoenix/fate-effect";
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

			const note = yield* notes.add({...input, authorId: user.id}).pipe(orDieDrizzle);

			// Live publish: error channel is `never` by construction — a failed
			// publish can never fail the mutation, and it never blocks the response.
			yield* live.connection("Notes.feed", {id: "all"}).appendNode("Note", note.id, {node: note});

			return note;
		}),
	),
};
```

What the types enforce here:

- **The declared error union is checked at the call site.** If the handler can fail with
  something not in `error`, the `Fate.mutation(...)` call itself is a compile error.
- **`input` is already decoded** when the handler runs — invalid input is rejected *before* your
  code executes, as a `VALIDATION_ERROR`. Same for query/list `args` (absent args decode to `{}`;
  write args schemas as structs of `Schema.optional` fields and default with `args.x ?? N`).
- **Raw generators are not accepted** — the documented authoring form is
  `Effect.fn("<wire name>")(function* ...)`, which is also what names the trace span.
- `CurrentUser` and `LivePublisher` are ordinary services from the handler's point of view; the
  serving layer provides fresh per-request values.

Queries are the same minus `input`: `Fate.query({args: ArgsSchema, type: NoteView}, handler)`,
where the handler bag is `{args, select}` — `select` is the client's field selection, useful for
skipping expensive nested work (see sozluk's `term` query).

### 5. Compose: one config, one layer

```ts
import {FateServer} from "@phoenix/fate-effect";

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
// MINUS CurrentUser/LivePublisher (those are per-request, provided by the route).
export const FateLive = FateServer.layer(fateConfig).pipe(
	Layer.provideMerge(Notes.layer), // discharge domain services here
);
```

Composition is where the remaining contracts fire:

- A handler requirement you forgot to provide is a **compile error** at the
  `Layer.provide` site — not a runtime "service not found".
- Config validation runs at layer build (and at codegen, so a bad config fails `pnpm build`):
  duplicate wire names and view-reachable entities without a source throw with every offender
  named.

### 6. Serve and generate

The serving path is one Effect — run it on your request fiber:

```ts
import {FateInterpreter, type FateRequestContext} from "@phoenix/fate-effect";

// per request:
const context: FateRequestContext = {
	currentUser: {user: session?.user ?? null},
	livePublisher, // the worker builds this from its live topics + waitUntil
	signal: request.signal,
};
const response = yield* FateInterpreter.handleRequest(request, context);
```

The interpreter owns no runtime — the caller decides how the Effect runs (phoenix's worker
yields it inside its HTTP route; the test suite runs it through a `ManagedRuntime`). Abort
signals are likewise the caller's wiring; see the worker's
[route](../../apps/web/worker/features/fate/route.ts) for the abort→interruption pattern.

Client codegen needs the same config with **inert** handlers — no database, importable at build
time:

```ts
// schema.ts — the fate Vite plugin imports this via runnerImport
import {FateExecutor} from "@phoenix/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
```

`InferFateAPI<typeof fateServer>` produces the same client types as the live server — pinned by
type-level tests in this package.

## The rules, in one list

| Invariant | Enforced by |
| --- | --- |
| A source with no loader doesn't exist | type-level (`SourceLoaderContract`) |
| Loaders can't fail typefully; infra dies | `E = never` on handler slots |
| Undeclared wire errors don't compile | `E extends DefinitionErrors<D>` bound |
| Invalid input never reaches a handler | Schema decode in the entry's `resolve` |
| A missing domain layer doesn't compile | `FateServer.layer`'s `R` |
| Wire codes can't silently drift | per-feature enumeration pin tests |
| A failed live publish can't fail a mutation | `LivePublisher` methods are `Effect<void>` |
| One Effect→Promise boundary in the package | an enumeration test source-greps for `run*` |
| v2 serves exactly what fate would | the differential oracle (byte-equal corpus) |

## Module map

| Module | What it is |
| --- | --- |
| `WireError.ts` | `fateWireCode` annotation + `encodeWireError` (the one error codec) |
| `DataView.ts` | `FateDataView` class factory, `Entity<>`, `FateDataView.list` |
| `Source.ts` | `Fate.source` — per-entity loaders, span-named handlers |
| `Operation.ts` | `Fate.query` / `Fate.list` / `Fate.mutation` + `InputValidationError` |
| `Server.ts` | `FateServer` tag, `config`, `layer`; init-time config validation |
| `CurrentUser.ts`, `LivePublisher.ts` | the per-request pair (tags; values come from the host) |
| `Protocol.ts` | the wire protocol as Effect Schema, drift-pinned against fate's types |
| `Interpreter.ts`, `Walk.ts`, `Connection.ts` | the native serving path: dispatch, selection walk with `RequestResolver` batching, pagination |
| `Executor.ts` | the v1 compile step — today the differential oracle's baseline and the `toCodegenServer` build surface |

## Going deeper

- Pattern docs (how to write feature code):
  [data views](../../.patterns/fate-effect-data-views.md) ·
  [sources](../../.patterns/fate-effect-sources.md) ·
  [operations](../../.patterns/fate-effect-operations.md) ·
  [wire errors](../../.patterns/fate-effect-wire-errors.md) ·
  [server](../../.patterns/fate-effect-server.md) ·
  [interpreter](../../.patterns/fate-effect-interpreter.md) ·
  [worker wiring](../../.patterns/fate-effect-worker-wiring.md) ·
  [feature migration](../../.patterns/fate-effect-feature-migration.md)
- Decisions (the why): [ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md) (v1
  architecture), [ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md)
  (native interpreter cutover)
