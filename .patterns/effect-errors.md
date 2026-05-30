# Effect errors

Failure in phoenix's backend is modeled as tagged errors in the `E` channel. No thrown exceptions across service boundaries. No `instanceof` chains in resolvers.

## Two flavors of tagged error

Effect ships two error constructors. Pick one per error type:

### `Data.TaggedError` — the default

Lightweight, runtime-only. Use for almost everything.

```ts
import {Data} from "effect";

export class DefinitionNotFound extends Data.TaggedError("sozluk/DefinitionNotFound")<{
  readonly definitionId: string;
}> {}

export class BodyTooLong extends Data.TaggedError("sozluk/BodyTooLong")<{
  readonly max: number;
}> {}
```

Notes:

- Tag strings are **namespaced**: `feature/ErrorName`. Collisions between features are obvious that way.
- The fields object is the error's runtime payload. Keep it small — just what the resolver needs to format a user-facing message.
- A `Data.TaggedError` is a yieldable Effect — `return yield* new DefinitionNotFound({definitionId})` fails the surrounding `Effect.gen`.

### `Schema.TaggedErrorClass` — when the error crosses a serialization boundary

Reserve for errors that round-trip through JSON (RPC, persistent message queues, error replay logs). All errors raised inside the worker are caught and re-encoded by `encodeFateError` at the fate boundary before they leave, so `Data.TaggedError` is the right default for feature services. `Schema.TaggedErrorClass` is the right choice if and when a service starts publishing errors to a transport the recipient parses back into typed objects.

```ts
import {Schema} from "effect";

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  id: Schema.Number,
}) {}
```

`Schema.encode(NotFound)(err)` produces a structurally-validated JSON wire form. The cost is more imports and a heavier class. Don't pay it unless you need the wire form.

## Where errors live

One `errors.ts` file per feature directory. Every tagged error a feature can raise — from its service methods or its inner helpers — is exported from there.

```
worker/features/sozluk/
├── Sozluk.ts        # service definition + live layer
├── errors.ts        # all tagged errors this feature raises
└── ...
```

Why one file:

- `encodeFateError` imports the full error set to map `_tag` → wire code via its typed registry. Easier when they're co-located.
- Cross-feature consumers (`Pano.voteOnPost` raising a vote error) can import from `vote/errors.ts` without pulling in the service.
- Tests stub the failure cases by constructing the error class directly — no service layer needed.

## Two categories per feature: domain + infra

Every feature ends up with two flavors of tagged error. Keep them distinct.

**Domain errors** — things the user did wrong or business-rule violations:

```ts
export class BodyRequired extends Data.TaggedError("sozluk/BodyRequired")<{}> {}
export class BodyTooLong extends Data.TaggedError("sozluk/BodyTooLong")<{readonly max: number}> {}
export class DefinitionNotFound extends Data.TaggedError("sozluk/DefinitionNotFound")<{
  readonly definitionId: string;
}> {}
export class UnauthorizedDefinitionMutation extends Data.TaggedError("sozluk/Unauthorized")<{
  readonly definitionId: string;
}> {}
```

These map to specific wire codes (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, `UNAUTHORIZED`) and user-facing messages. The resolver pattern-matches on them.

**Infrastructure errors** — things that went wrong below the domain:

```ts
// From db/Drizzle.ts
export class DrizzleError extends Data.TaggedError("@phoenix/Drizzle/Error")<{
  readonly cause: unknown;
}> {}
```

These map to 500s / `INTERNAL_SERVER_ERROR`. Their `cause` is preserved for logging but not surfaced to the user.

The split matters because: domain errors are *expected* (they happen on the happy path of an invalid input), infrastructure errors are *unexpected* (they indicate a bug or outage). The wire encoding handles them differently — don't conflate them.

## Composing error unions

A service method's `E` channel is the union of every error its body can raise. Be explicit — don't widen to `unknown`:

```ts
readonly editDefinition: (
  input: EditDefinitionInput,
) => Effect.Effect<
  EditDefinitionResult,
  | BodyRequired
  | BodyTooLong
  | DefinitionNotFound
  | UnauthorizedDefinitionMutation
  | DrizzleError
>;
```

The explicit union is the method's contract. TypeScript will:

- Force resolvers to handle every tag the method can raise (or pass them through to the wrapper).
- Catch you when you add a new failure case to the body but forget to widen the signature.
- Catch you when you remove a case from the body but leave the signature wide.

Read effect-smol's `MessageStorage` (in `packages/effect/src/unstable/cluster/MessageStorage.ts`) for a real codebase example — every method spells out exactly which errors it can raise.

## Raising errors inside `Effect.fn`

The terminal-error pattern:

```ts
const editDefinition = Effect.fn("Sozluk.editDefinition")(function*(input) {
  const body = yield* validateBody(input.body);          // may fail with BodyRequired | BodyTooLong
  const existing = yield* getDefinition(input.definitionId); // may fail with DefinitionNotFound

  if (existing.authorId !== input.actorId) {
    return yield* new UnauthorizedDefinitionMutation({
      definitionId: input.definitionId,
    });
  }

  yield* run("editDefinition.update", () => db.update(...));
  return {/* result */};
});
```

The two ways errors enter the channel:

- **From a yielded effect** — `yield* validateBody(...)` returns either the success value or fails. No `if` needed; the failure short-circuits.
- **From an explicit `return yield* new MyError(...)`** — when an inline condition (like an ownership check) needs to fail with a specific tag.

**Always use `return yield*` for terminal errors.** Without `return`, code after the error is unreachable but TypeScript won't warn. See [effect-context-service.md](./effect-context-service.md#return-yield-pattern-for-errors) for the full rationale.

## Catching tags — pattern matching

When a method needs to recover from one specific error (not propagate it):

```ts
const ensureTermExists = Effect.fn("Sozluk.ensureTermExists")(function*(slug) {
  return yield* getTerm(slug).pipe(
    Effect.catchTag("sozluk/TermNotFound", () =>
      createBlankTerm(slug),
    ),
  );
});
```

`Effect.catchTag(tag, handler)` removes that specific tag from the `E` channel and replaces it with whatever the handler returns. Use it sparingly — most errors should propagate to the fate boundary and become wire codes.

`Effect.catchTags({tag1: handler, tag2: handler})` handles multiple at once.

## Mapping to wire codes (the fate boundary)

The bridge runner (`worker/fate/effect.ts`) catches every error in the `E` channel and routes it through `encodeFateError` (`worker/fate/errors.ts`), which maps `_tag` → wire code via a typed registry to produce a `FateRequestError` with a stable `code`:

```ts
// worker/fate/errors.ts — the registry is Record<FateErrorTag, WireCodeFor>,
// so a tagged error with no entry is a compile error (no silent downgrade).
export const WIRE_CODE_BY_TAG: Record<FateErrorTag, WireCodeFor> = {
  "sozluk/BodyRequired": fixed("BODY_REQUIRED", "Tanım boş olamaz"),
  "sozluk/BodyTooLong": (e) =>
    fateError("BODY_TOO_LONG", `Tanım en fazla ${e.max} karakter olabilir`),
  "sozluk/DefinitionNotFound": fixed("DEFINITION_NOT_FOUND", "Tanım bulunamadı"),
  // ...
  "@phoenix/Drizzle/Error": fixed("INTERNAL_SERVER_ERROR", "internal error"),
};

export function encodeFateError(err: unknown): FateRequestError {
  if (err instanceof FateRequestError) return err; // already on the wire
  // look the _tag up in WIRE_CODE_BY_TAG; default unknown/non-tagged throws to
  // INTERNAL_SERVER_ERROR.
}
```

Wire codes (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, etc.) are the public contract — frontend clients depend on them. The `_tag` namespace (`feature/Name`) is the internal contract. Both can change independently of each other, but the typed `WIRE_CODE_BY_TAG` registry is the single, exhaustiveness-checked point where they meet.

## Anti-patterns

- **Throwing inside an `Effect.fn`.** The throw becomes a defect, not a typed error — it bypasses the `E` channel. Use `return yield* new MyError(...)`.
- **One generic `FeatureError` class with a `code` discriminator field.** Collapses the `E` channel to a single type and forces resolvers to switch on a runtime `.code` field instead of `._tag`. Define one tagged error class per failure case.
- **Catching infra errors in domain code.** `Effect.catchTag("@phoenix/Drizzle/Error", ...)` inside a feature service usually means you're hiding a real failure. Let it propagate to the fate boundary, which encodes it as `INTERNAL_SERVER_ERROR`. Recovery from infra errors belongs in retry middleware, not in domain logic.

## See also

- [effect-context-service.md](./effect-context-service.md) — service mechanics, `return yield*` pattern
- [feature-services.md](./feature-services.md) — where errors plug into the service shape
- [effect-error-operators.md](./effect-error-operators.md) — catching, `Exit`, `Cause`, recovering from specific tags
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema.TaggedErrorClass` for errors that cross serialization boundaries
- `worker/features/pasaport/Auth.ts` — `Unauthorized` is the canonical phoenix tagged error
- `worker/fate/errors.ts` — `encodeFateError` + the typed `WIRE_CODE_BY_TAG` registry
