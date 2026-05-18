# Schema for input validation at trust boundaries

When and how to use `effect/Schema` for runtime validation in phoenix. Schema is reserved for **trust boundaries** — places where genuinely untyped data enters the worker.

## Where the trust boundary actually is

GraphQL resolvers are **not** a trust boundary. Yoga validates GraphQL args against the SDL before they reach the resolver — by the time the resolver runs, args are typed and structurally valid. Adding Schema validation at the resolver layer would re-validate what's already validated.

The real boundaries in phoenix:

- **Admin route bodies** — Hono's `c.req.json()` returns `unknown`. The admin route handler is the boundary; Schema parses the JSON into a typed value before calling the admin service method.
- **External API responses** — when phoenix fetches from an outside service. The response is untyped.
- **Persisted JSON columns** — if phoenix ever stores arbitrary JSON in D1.

For GraphQL: validation of *semantic* constraints (string length, format patterns, business invariants) lives **inside the service method**, not at the resolver. The service owns its own invariants — see [feature-services.md](./feature-services.md). Service methods do this validation in plain TS (if/else with tagged errors), or with `Schema.decodeUnknown` if the validation is genuinely complex.

## `Schema.Class` — the canonical shape

`Schema.Class` produces a class that's both the runtime parser and the TypeScript type:

```ts
import {Schema} from "effect";

export class SeedTermBody extends Schema.Class<SeedTermBody>("SeedTermBody")({
  slug: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(200),
    Schema.pattern(/^[a-z0-9-]+$/),
  ),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  definitions: Schema.Array(Schema.Struct({
    authorId: Schema.String,
    authorName: Schema.String,
    body: Schema.String.pipe(Schema.maxLength(10_000)),
  })),
}) {}
```

`SeedTermBody` is:

- A **TypeScript type** (used like any class).
- A **runtime parser**: `Schema.decodeUnknown(SeedTermBody)(rawJson)` → `Effect<SeedTermBody, ParseError>`.
- An **encoder**: `Schema.encode(SeedTermBody)(instance)` → the JSON wire form.

## Parsing at an admin route boundary

```ts
// worker/index.ts (or admin routes file)
app.post("/api/admin/sozluk/upsert-term", async (c) => {
  return adminRuntime(c.env).runPromise(Effect.gen(function*() {
    const auth = yield* AdminAuth;
    yield* auth.required;

    const raw = yield* Effect.tryPromise({
      try: () => c.req.json(),
      catch: (cause) => new BadRequest({cause}),
    });
    const body = yield* Schema.decodeUnknown(SeedTermBody)(raw);

    const admin = yield* SozlukAdmin;
    return yield* admin.seedTerm(body);
  }));
});
```

The route handler is the boundary. Past `Schema.decodeUnknown`, the admin service receives a typed `SeedTermBody` and never re-validates structure. The service can still enforce domain rules (e.g., uniqueness, ownership) — those are different from structural validation.

## Service-method validation, not Schema

For domain rules inside a service method (string non-empty, length caps, regex patterns, etc.), use plain TS with tagged errors:

```ts
// inside Sozluk.addDefinition's body
const validateBody = (raw: string) => {
  if (raw.trim().length === 0) return new BodyRequired();
  if (raw.length > DEFINITION_BODY_MAX) return new BodyTooLong({max: DEFINITION_BODY_MAX});
  return Effect.succeed(raw);
};

addDefinition: Effect.fn("Sozluk.addDefinition")(function*(input: AddDefinitionInput) {
  const body = yield* validateBody(input.body);
  // ...
}),
```

The error tags appear in the method's `E` channel, the resolver maps them to wire codes. Same pattern, no Schema needed.

Reach for `Schema.decodeUnknown` *inside* a service method only when the validation is genuinely complex enough to be tedious as if/else — nested shape validation, conditional fields, branded primitives. Even then, the schema lives inside the service's closure as an implementation detail, not at the method signature.

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

Phoenix doesn't have this need — all errors are encoded by the resolver wrapper into `GraphQLError`s before leaving the worker. Reserve `Schema.TaggedErrorClass` for the moment you need wire-form errors.

## Schema features worth knowing about

Documented in `effect-smol`'s `Schema.ts` (`packages/effect/src/Schema.ts`). Not exhaustive, just what phoenix would actually use:

- **`Schema.String`, `Schema.Number`, `Schema.Boolean`, `Schema.Date`, `Schema.BigInt`** — primitives.
- **`Schema.Array(itemSchema)`, `Schema.Record({key, value})`, `Schema.Tuple(...)`** — collections.
- **`Schema.Union([SchemaA, SchemaB])`, `Schema.Literal("a", "b", "c")`** — discriminated unions and enum-like literals.
- **`Schema.optional(schema)`, `Schema.optionalWith(schema, {default})`** — optional fields.
- **`.pipe(Schema.minLength(n))`, `Schema.maxLength`, `Schema.pattern`, `Schema.startsWith`** — string refinements.
- **`Schema.brand("UserId")`** — nominal types (`Schema.String.pipe(Schema.brand("UserId"))` makes `UserId` a distinct type from `string`).
- **`Schema.transform(from, to, {decode, encode})`** — bidirectional codecs for changing shape between wire and domain.

## Anti-patterns

- **Schema at the GraphQL resolver layer.** GraphQL SDL is the boundary; Yoga has already validated. Schema here is redundant and leaks validation infrastructure into product code. Domain validation (length, format, etc.) belongs inside the service method as tagged-error checks.
- **Schema everywhere.** Validating internal data is ceremony. Schema costs runtime parse time at every call.
- **Defining a Schema for a type that already exists as a TypeScript interface.** Pick one — either Schema (and use `Schema.Schema.Type<typeof X>` to get the type) or interface. Maintaining both is a smell.
- **Schema for drizzle rows.** Drizzle already gives you types from the schema. Re-parsing is redundant.

## See also

- [feature-services.md](./feature-services.md) — service methods own their input validation
- [effect-errors.md](./effect-errors.md) — tagged errors for domain validation failures, `Schema.TaggedErrorClass` for wire-form errors
- [effect-error-operators.md](./effect-error-operators.md) — handling `ParseError` when it does come up (admin boundaries)
- effect-smol `Schema.ts` — full API reference at `packages/effect/src/Schema.ts`
