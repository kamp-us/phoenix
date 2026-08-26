# @kampus/fate-effect walkthrough

The full numbered walkthrough — building one small feature (a `Note` entity with a read, a
write, and a live update) end to end. Every piece is the real API; the in-repo worked example
is sozluk ([views](../../apps/web/worker/features/sozluk/views.ts),
[sources](../../apps/web/worker/features/sozluk/sources.ts),
[queries](../../apps/web/worker/features/sozluk/queries.ts),
[mutations](../../apps/web/worker/features/sozluk/mutations.ts),
[errors](../../apps/web/worker/features/sozluk/errors.ts)). The README carries the shape and
the reference; this page carries the narrative.

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
			yield* live.topic("Notes.feed", {id: "all"}).appendNode("Note", note.id, {node: note});

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

`LivePublisher` publishes three ways to a row and four to a connection:

| Call | Tells subscribers |
| --- | --- |
| `live.update(type, id, {changed, data})` | here are these fields' new values |
| `live.delete(type, id)` | this row is gone |
| `live.invalidate(type, id)` | read this row again — no data attached |
| `live.topic(procedure, args).{appendNode,prependNode,deleteEdge,invalidate}(…)` | this connection's membership moved, or re-load it whole |

`invalidate` is the only honest repair for a **viewer-derived** field — one whose value depends on
who is reading, like a viewer's own vote or a moderation marker. Its true new value differs per
subscriber, so a broadcast payload would overwrite every reader with the mutator's answer;
attaching no data is what forces each subscriber to re-read on its own viewer
([ADR 0314](../../.decisions/0314-entity-invalidate-frame-upstream.md)).

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
