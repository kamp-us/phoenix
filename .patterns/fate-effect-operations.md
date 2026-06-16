# fate-effect operations — `Fate.query` / `Fate.list` / `Fate.mutation`

How `@kampus/fate-effect` declares operations. The short answer: **each record entry pairs a pure-data definition with a user-authored `Effect.fn("<wire name>")` handler** — Effect Schema replaces zod at the boundary, the success view names the wire type, and the handler's error channel is checked against the declared error union at the constructor call. This replaced the bridge's `fateQuery`/`fateList`/`fateMutation` helpers (deleted in the v1 cutover, ADR 0042). Sources are the other half of the loader/resolver split ([fate-effect-sources.md](./fate-effect-sources.md)): sources LOAD, operations RESOLVE.

## Declaring operations

Records stay exactly fate's shape — plain objects keyed by dotted wire names:

```ts
import {Fate} from "@kampus/fate-effect";
import {Effect, Schema} from "effect";
import {BodyRequired, DefinitionNotFound} from "./errors.ts";
import {Sozluk} from "./Sozluk.ts";
import {DefinitionView, TermView} from "./views.ts";

const AddDefinitionInput = Schema.Struct({
	termSlug: Schema.String,
	body: Schema.String,
});

export const mutations = {
	"definition.add": Fate.mutation(
		{
			input: AddDefinitionInput,
			type: DefinitionView,
			error: Schema.Union([BodyRequired, DefinitionNotFound]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const sozluk = yield* Sozluk;
			return yield* sozluk.addDefinition(input);
		}),
	),
};

export const queries = {
	term: Fate.query(
		{args: Schema.Struct({slug: Schema.String}), type: TermView},
		Effect.fn("term")(function* ({args, select}) {
			const sozluk = yield* Sozluk;
			return yield* sozluk.getTerm(args.slug);
		}),
	),
};
```

- **The definition is pure data**: `input`/`args` (Effect Schema), `type` (a `FateDataView` class, or the wire type-name string for viewless types like `Health`), `error` (one error class, or `Schema.Union([...])` of several — optional; absent means the handler cannot fail). The entry's `.type` is the normalized wire name, kept literal (`"Definition"`, not `string`) — `InferFateAPI` fidelity depends on it.
- **The handler is `Effect.fn("<wire name>")`** — the wire name (the record key) is the span name, so traces point at the operation. The handler slot accepts **Effect-returning functions only**; raw generators don't typecheck. This is the deliberate asymmetry with `Fate.source`, which wraps plain bodies itself: a source capability's span name is fully determined by entity+capability, while an operation's wire name is author-owned.
- Contextual typing flows through `Effect.fn` into the generator's parameters: `{input}` / `{args, select}` need **no annotations** — they are the Schema's decoded `Type`.
- `Fate.list` pins the handler's success to fate's `ConnectionResult` — keyset pagination stays service-owned (ADR 0019).

## The error contract

The constructor bounds the handler's `E` by the declared union (`E extends DefinitionErrors<D>`), so **failing with an undeclared error is a compile error at the constructor call** — it surfaces as TS2345 on the handler argument (and the effect LSP plugin's TS377003 "Missing errors … in the expected Effect type"). Declared errors are annotated with `ErrorCode` ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)); the wire boundary (`encodeWireError` — used by the interpreter's dispatch and the oracle-baseline compile step alike) derives their wire codes from the annotation, no registry.

Declared unions are DOMAIN errors only. Infrastructure failures never enter a handler's `E`: domain services die on them internally ([feature-services.md](./feature-services.md) boundary rule), so a handler calls the service bare — no `orDie` pipe at the call site, no `Drizzle` import in an operations file — and a DB failure reaches the wire as `INTERNAL_SERVER_ERROR` via `encodeWireError`'s defect path.

## The decode-then-run wrapper (`entry.resolve`)

Each entry carries `resolve` — the Effect the interpreter's dispatch yields per operation (and what the oracle-baseline compiler adapts to fate's promise-shaped resolvers):

- **Mutation `input` is decoded before the handler runs.** A Schema rejection fails with the package's `InputValidationError` (annotated `VALIDATION_ERROR`, the code fate itself emits for schema failures); the handler never sees invalid input.
- **Query/list `args` decode wire args including absence**: missing wire args decode as the empty bag `{}`, so args schemas are structs of optional fields and a declared-args handler never sees `undefined`. A definition without an `args` schema passes `undefined` — stray wire args are not smuggled past the declared contract.
- `R` is inferred from the handler and visible on the entry (`FateOperationServices<typeof op>`), so a forgotten domain layer is a compile error at the composition site (`FateServer.layer`).

## Write conventions

How phoenix mutations are shaped, beyond the constructor mechanics:

- **Names are `entity.verb`** (`definition.add`, `post.submit`, `comment.delete`) — namespaced commands that read as the action they perform. The wire name is the record key AND the `Effect.fn` span name.
- **Domain validation lives in the service** ([ADR 0013](../.decisions/0013-validation-in-service-methods.md)). The service raises the domain errors whose `ErrorCode` annotations become wire codes; the definition's `input` Schema is shape coercion at the trust boundary only. Don't restate domain rules in the Schema — the service is the single source of truth.
- **Return the changed entity's shaped row.** After the write, the service returns the fresh row and the feature's shaper maps it to the entity field set; fate masks it to the client's selection exactly as it masks a read — no hand-shaped responses.
- **A delete returns the affected *parent* entity, re-resolved**, so the client's normalized cache updates the surrounding list: `definition.delete` returns the `Term`, `comment.delete` returns the `Post`. A parentless entity (`post.delete`) returns the deleted entity's `{__typename, id}` instead — there is no parent to re-resolve.
- **Publish live events after the write**, through the per-request `LivePublisher` service, so subscribed views update in place:

  ```ts
  const live = yield* LivePublisher;
  yield* live.update("Definition", id, {data: definition});                    // entity change
  yield* live.connection("Term.definitions", {id: termSlug}).appendNode("Definition", id, {node: definition});
  ```

  Every publish method is `Effect<void>` (`E = never`) — a failed publish cannot fail the committed mutation; the swallow-with-log lives inside the implementation ([fate-effect-server.md](./fate-effect-server.md)). Publish the **already shaped** entity/node inline as `data`/`node`: the handler shaped it for the response, so the live event carries resolved data and clients mask it to their own selection. The mutating client gets the entity returned directly; live events update *other* clients. See [fate-live-views.md](./fate-live-views.md).

## What not to do

- Don't author handlers as raw generators or `() => Effect.gen(...)` — the documented form is `Effect.fn("<wire name>")(function* ...)`; the types only accept Effect-returning functions.
- Don't pre-validate inside the handler what the Schema already declares — the wrapper rejects invalid input before the handler runs; the handler's `input`/`args` are already decoded.
- Don't fail with an error outside the declared union "temporarily" — widen the union in the definition instead; the bound exists so the wire contract and the handler cannot drift.
- Don't reach for `@ts-expect-error` to pin error-union violations in tests — the effect LSP plugin's TS377003 escapes the directive (a recurring finding); pin the `DefinitionErrors<D>` bound with `expectTypeOf` instead.

`packages/fate-effect/src/Operation.unit.test.ts` is the standing guard: exported operation consts keep the TS2883 nameability gate honest, the `DefinitionErrors` pins guard the error bound, and the decode tests pin the `entry.resolve` wrapper contract.
