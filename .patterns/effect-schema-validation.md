# Schema for input validation at boundaries

When and how to use `effect/Schema` for runtime validation in phoenix. Schema is reserved for **trust boundaries** — places where untyped data enters the system. Don't use it for everything.

## When to reach for Schema

Use Schema when data crosses a boundary where types are not enforced:

- **GraphQL inputs** that need richer validation than the GraphQL schema provides (e.g., string format constraints, numeric ranges, semantic invariants).
- **Hono request bodies** for admin routes (untyped JSON in, typed object out).
- **External API responses** when phoenix calls an outside service.
- **Persisted JSON columns** if phoenix ever stores arbitrary JSON in D1.

Don't use Schema when:

- The data is already typed by drizzle (rows coming out of `db.select()`).
- The data is internal to a service (already validated upstream).
- All you need is a TypeScript type, not runtime parsing — use a plain `interface` or `type`.

## `Schema.Class` — the canonical shape

Schema's most useful constructor for phoenix is `Schema.Class`. It produces a class that is both the runtime parser and the TypeScript type:

```ts
import {Schema} from "effect";

export class AddDefinitionInput extends Schema.Class<AddDefinitionInput>("AddDefinitionInput")({
  termSlug: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(200),
    Schema.pattern(/^[a-z0-9-]+$/),
  ),
  authorId: Schema.String,
  authorName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10_000)),
  termTitle: Schema.optional(Schema.String),
}) {}
```

`AddDefinitionInput` is now:

- A **TypeScript type**: `AddDefinitionInput` (used like any class).
- A **runtime parser**: `Schema.decodeUnknown(AddDefinitionInput)(rawJson)` returns an `Effect<AddDefinitionInput, ParseError>`.
- An **encoder**: `Schema.encode(AddDefinitionInput)(instance)` produces the JSON wire form.

## Parsing at the boundary

```ts
import {Effect, Schema} from "effect";

// inside a GraphQL resolver
resolve: resolver(function*(_source, args: unknown) {
  const input = yield* Schema.decodeUnknown(AddDefinitionInput)(args);
  // input is now typed AddDefinitionInput, runtime-validated
  const sozluk = yield* Sozluk;
  return yield* sozluk.addDefinition(input);
}),
```

`decodeUnknown` returns `Effect<AddDefinitionInput, ParseError>`. If parsing fails, the resolver wrapper catches `ParseError` and maps it to a wire code (you'll add this case to `encodeMutationError`).

## Don't use Schema where the type system already won

If a service method takes `AddDefinitionInput` and the resolver constructs it from already-typed GraphQL args (yoga validates against the SDL), there's no untyped data to parse. Schema would just re-validate what's already validated.

The boundary is "untyped JSON arrives." Past that point, plain TypeScript types are enough.

## Schema for tagged errors that cross boundaries

[effect-errors.md](./effect-errors.md) covers this briefly. If an error needs to round-trip through JSON (RPC, persisted error log, message queue), use `Schema.TaggedErrorClass`:

```ts
export class PersistedAuditError extends Schema.TaggedErrorClass<PersistedAuditError>()("PersistedAuditError", {
  userId: Schema.String,
  action: Schema.String,
  timestamp: Schema.DateTimeUtc,
}) {}
```

`Schema.encode(PersistedAuditError)(err)` produces a structurally-validated JSON form. `Schema.decode(PersistedAuditError)(json)` reconstructs the typed error.

Phoenix doesn't have this need today — all errors are encoded by the resolver wrapper into `GraphQLError`s before leaving the worker. Reserve `Schema.TaggedErrorClass` for the moment you need wire-form errors.

## Schema features worth knowing about

These are documented in `effect-smol`'s `Schema.ts` (`packages/effect/src/Schema.ts`). Not exhaustive, just what phoenix would actually use:

- **`Schema.String`, `Schema.Number`, `Schema.Boolean`, `Schema.Date`, `Schema.BigInt`** — primitives.
- **`Schema.Array(itemSchema)`, `Schema.Record({key, value})`, `Schema.Tuple(...)`** — collections.
- **`Schema.Union([SchemaA, SchemaB])`, `Schema.Literal("a", "b", "c")`** — discriminated unions and enum-like literals.
- **`Schema.optional(schema)`, `Schema.optionalWith(schema, {default})`** — optional fields.
- **`.pipe(Schema.minLength(n))`, `Schema.maxLength`, `Schema.pattern`, `Schema.startsWith`** — string refinements.
- **`Schema.brand("UserId")`** — nominal types (`Schema.String.pipe(Schema.brand("UserId"))` makes `UserId` a distinct type from `string`).
- **`Schema.transform(from, to, {decode, encode})`** — bidirectional codecs for changing shape between wire and domain.

## Anti-patterns

- **Schema everywhere.** Validating internal data is ceremony. Schema costs runtime parse time at every call — that adds up if you sprinkle it through hot paths.
- **Defining a Schema for a type that already exists as a TypeScript interface.** Pick one — either Schema (and use `Schema.Schema.Type<typeof X>` to get the type) or interface. Maintaining both is a smell.
- **`Schema.decodeUnknown` without handling `ParseError`.** The error needs to map to a wire code. Either add the `ParseError` case to `encodeMutationError` or convert via `Effect.mapError(err => new MyDomainError({cause: err}))`.
- **Schema for drizzle rows.** Drizzle already gives you types from the schema. Re-parsing through Schema is redundant.

## See also

- [effect-errors.md](./effect-errors.md) — when to use `Schema.TaggedErrorClass`
- [effect-error-operators.md](./effect-error-operators.md) — handling `ParseError` at boundaries
- effect-smol `Schema.ts` — full API reference at `~/code/github.com/usirin/effect-smol/packages/effect/src/Schema.ts`
