# Effect errors

Failure in phoenix's backend is modeled as tagged errors in the `E` channel. No thrown exceptions across service boundaries. No `instanceof` chains in resolvers.

## The error constructor — `Schema.TaggedErrorClass`, annotated

Every phoenix error class is a `Schema.TaggedErrorClass`. The schema form is load-bearing: a
domain error that can reach the wire carries its wire code as a **schema annotation**
(`fateWireCode`, [fate-effect-wire-errors.md](./fate-effect-wire-errors.md)), and annotations
ride the class's AST — `Data.TaggedError` has nowhere to put one.

```ts
import * as Schema from "effect/Schema";
import {fateWireCode} from "@phoenix/fate-effect";

export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
  "sozluk/DefinitionNotFound",
  {definitionId: Schema.String, message: Schema.String},
  {[fateWireCode]: "DEFINITION_NOT_FOUND"},
) {}
```

Notes:

- Tag strings are **namespaced**: `feature/ErrorName`. Collisions between features are obvious that way.
- The fields object is the error's runtime payload. Keep it small — just what's needed to format a user-facing `message` (the annotated encoder puts `message` on the wire).
- A `Schema.TaggedErrorClass` instance is a yieldable Effect — `return yield* new DefinitionNotFound({...})` fails the surrounding `Effect.gen`.
- An infra error (or any error that must never reach the wire) simply carries **no annotation** — un-annotated failures encode as `INTERNAL_SERVER_ERROR` with a fixed message (no detail leak).
- **One class, one code.** The annotation is class-level; an error family with several codes splits into one class per code, with a union type alias for service signatures (pano's `PostValidation`, pasaport's `UsernameInvalid`).

## Where errors live

One `errors.ts` file per feature directory. Every tagged error a feature can raise — from its service methods or its inner helpers — is exported from there.

```
worker/features/sozluk/
├── Sozluk.ts        # service definition + live layer
├── errors.ts        # all tagged errors this feature raises
└── ...
```

Why one file:

- The feature's wire-code enumeration pin (`<feature>/errors.unit.test.ts`) imports the full set to assert every class ↔ code pair. Easier when they're co-located.
- Cross-feature consumers (`Pano.voteOnPost` catching a vote error) can import from `vote/errors.ts` without pulling in the service.
- Tests stub the failure cases by constructing the error class directly — no service layer needed.

## Two categories per feature: domain + infra

Every feature ends up with two flavors of tagged error. Keep them distinct.

**Domain errors** — things the user did wrong or business-rule violations:

```ts
export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
  "sozluk/BodyRequired",
  {message: Schema.String},
  {[fateWireCode]: "BODY_REQUIRED"},
) {}
export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
  "sozluk/DefinitionNotFound",
  {definitionId: Schema.String, message: Schema.String},
  {[fateWireCode]: "DEFINITION_NOT_FOUND"},
) {}
```

These carry their wire codes (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, …) as annotations and user-facing messages. Handlers declare them in the operation's `error` union and pattern-match on them.

**Infrastructure errors** — things that went wrong below the domain:

```ts
// From db/Drizzle.ts — NO fateWireCode annotation, by design
export class DrizzleError extends Schema.TaggedErrorClass<DrizzleError>()(
  "@phoenix/Drizzle/Error",
  {cause: Schema.Defect()},
) {}
```

These never appear in a declared error union: fate handlers pipe service calls through `orDieDrizzle` (`worker/db/Drizzle.ts`), turning the failure into a defect — which encodes as `INTERNAL_SERVER_ERROR` with a fixed message. The `cause` is preserved for logging but not surfaced to the user.

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

The interpreter's dispatch catches every error in the `E` channel and routes it through
`@phoenix/fate-effect`'s `encodeWireError` (the oracle-baseline compile step uses the same
helper), which reads the `fateWireCode` annotation off the error's class to produce a
`FateRequestError` with a stable `code` — no registry, one edit per error
([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)):

- **annotated error** → its annotated code + its own `message`;
- **un-annotated error / defect** → `INTERNAL_SERVER_ERROR` with a fixed message;
- **`FateRequestError`** → passed through verbatim.

Wire codes (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, etc.) are the public contract — frontend
clients depend on them. The `_tag` namespace (`feature/Name`) is the internal contract. Two
guards keep them honest: each feature's `errors.unit.test.ts` pins every class ↔ code pair, and
`worker/features/fate/wireCodes.unit.test.ts` derives the server-emittable code set from the
fate config's declared error unions and asserts the SPA's `MUTATION_ERROR_CODES` covers it.

## Anti-patterns

- **Throwing inside an `Effect.fn`.** The throw becomes a defect, not a typed error — it bypasses the `E` channel. Use `return yield* new MyError(...)`.
- **One generic `FeatureError` class with a `code` discriminator field.** Collapses the `E` channel to a single type and forces resolvers to switch on a runtime `.code` field instead of `._tag`. Define one tagged error class per failure case.
- **Catching infra errors in domain code.** `Effect.catchTag("@phoenix/Drizzle/Error", ...)` inside a feature service usually means you're hiding a real failure. Let it propagate to the fate boundary, which encodes it as `INTERNAL_SERVER_ERROR`. Recovery from infra errors belongs in retry middleware, not in domain logic.

## See also

- [effect-context-service.md](./effect-context-service.md) — service mechanics, `return yield*` pattern
- [feature-services.md](./feature-services.md) — where errors plug into the service shape
- [effect-error-operators.md](./effect-error-operators.md) — catching, `Exit`, `Cause`, recovering from specific tags
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema.TaggedErrorClass` for errors that cross serialization boundaries
- `packages/fate-effect/src/CurrentUser.ts` — `Unauthorized` is the canonical annotated tagged error
- [fate-effect-wire-errors.md](./fate-effect-wire-errors.md) — the `fateWireCode` annotation + `encodeWireError` codec
