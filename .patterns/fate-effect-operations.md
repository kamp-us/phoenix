# fate-effect operations — `Fate.query` / `Fate.list` / `Fate.mutation`

How `@phoenix/fate-effect` declares operations. The short answer: **each record entry pairs a pure-data definition with a user-authored `Effect.fn("<wire name>")` handler** — Effect Schema replaces zod at the boundary, the success view names the wire type, and the handler's error channel is checked against the declared error union at the constructor call. This is the package's replacement for the bridge's `fateQuery`/`fateList`/`fateMutation` ([fate-effect-bridge.md](./fate-effect-bridge.md)), which keeps governing legacy records until the migration rewrites them. Sources are the other half of the loader/resolver split ([fate-effect-sources.md](./fate-effect-sources.md)): sources LOAD, operations RESOLVE.

## Declaring operations

Records stay exactly fate's shape — plain objects keyed by dotted wire names:

```ts
import {Fate} from "@phoenix/fate-effect";
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

- **The definition is pure data**: `input`/`args` (Effect Schema), `type` (a `FateDataView` class, or the wire type-name string for viewless types like `Health`), `error` (one error class, or `Schema.Union([...])` of several — optional; absent means the handler cannot fail). The entry's `.type` is the normalized wire name, kept literal (`"Definition"`, not `string`) — `InferFateAPI` fidelity depends on it (task 8).
- **The handler is `Effect.fn("<wire name>")`** — the wire name (the record key) is the span name, so traces point at the operation. The handler slot accepts **Effect-returning functions only**; raw generators don't typecheck. This is the deliberate asymmetry with `Fate.source`, which wraps plain bodies itself: a source capability's span name is fully determined by entity+capability, while an operation's wire name is author-owned.
- Contextual typing flows through `Effect.fn` into the generator's parameters: `{input}` / `{args, select}` need **no annotations** — they are the Schema's decoded `Type`.
- `Fate.list` pins the handler's success to fate's `ConnectionResult` — keyset pagination stays service-owned (ADR 0019).

## The error contract

The constructor bounds the handler's `E` by the declared union (`E extends DefinitionErrors<D>`), so **failing with an undeclared error is a compile error at the constructor call** — it surfaces as TS2345 on the handler argument (and the effect LSP plugin's TS377003 "Missing errors … in the expected Effect type"). Declared errors are annotated with `fateWireCode` ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)); the compile step derives their wire codes from the annotation, no registry.

## The decode-then-run wrapper (`entry.resolve`)

Each entry carries `resolve` — what task 7's compiler adapts to fate's promise-shaped resolvers:

- **Mutation `input` is decoded before the handler runs.** A Schema rejection fails with the package's `InputValidationError` (annotated `VALIDATION_ERROR`, the code fate itself emits for schema failures); the handler never sees invalid input.
- **Query/list `args` decode wire args including absence**: missing wire args decode as the empty bag `{}`, so args schemas are structs of optional fields and a declared-args handler never sees `undefined`. A definition without an `args` schema passes `undefined` — stray wire args are not smuggled past the declared contract.
- `R` is inferred from the handler and visible on the entry (`FateOperationServices<typeof op>`), so a forgotten domain layer is a compile error at the composition site (`FateServer.layer`, task 5).

## What not to do

- Don't author handlers as raw generators or `() => Effect.gen(...)` — the documented form is `Effect.fn("<wire name>")(function* ...)`; the types only accept Effect-returning functions.
- Don't pre-validate inside the handler what the Schema already declares — the wrapper rejects invalid input before the handler runs; the handler's `input`/`args` are already decoded.
- Don't fail with an error outside the declared union "temporarily" — widen the union in the definition instead; the bound exists so the wire contract and the handler cannot drift.
- Don't reach for `@ts-expect-error` to pin error-union violations in tests — the effect LSP plugin's TS377003 escapes the directive (recurring finding, tasks 3 and 4); pin the `DefinitionErrors<D>` bound with `expectTypeOf` instead.

`packages/fate-effect/src/Operation.unit.test.ts` is the standing guard: exported operation consts keep the TS2883 nameability gate honest, the `DefinitionErrors` pins guard the error bound, and the decode tests pin the wrapper contract task 7 builds on.
