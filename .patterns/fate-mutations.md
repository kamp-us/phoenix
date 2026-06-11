# Mutations

How writes work. The short answer: a `mutations` map on the fate config, each entry a
`Fate.mutation` value — a pure-data definition (Schema `input`, success view, declared `error`
union) paired with an `Effect.fn("<wire name>")` handler that calls a domain service to perform
the write, then **returns the affected entity's shaped row** so the response is shaped exactly
like a read. Authoring mechanics live in
[fate-effect-operations.md](./fate-effect-operations.md); this doc is the write *conventions*.

## The shape

```ts
// features/sozluk/mutations.ts → spread into the config (worker/features/fate/config.ts)
"definition.add": Fate.mutation(
  {
    input: AddDefinitionInput,                 // Effect Schema — decoded pre-handler
    type: DefinitionView,                      // entity type returned (for client cache)
    error: Schema.Union([Unauthorized, BodyRequired, BodyTooLong]),
  },
  Effect.fn("definition.add")(function* ({input}) {
    const user = yield* CurrentUser.required;  // → UNAUTHORIZED (declared above)
    const sozluk = yield* Sozluk;
    const live = yield* LivePublisher;
    const result = yield* sozluk.addDefinition({...input, authorId: user.id});
    const definition = shapeDefinition({...result, myVote: null});
    yield* live
      .connection("Term.definitions", {id: input.termSlug})
      .appendNode("Definition", definition.id, {node: definition});
    return definition;                         // shape == a read; fate masks to the selection
  }),
),
```

Operation names are **`entity.verb`** (`definition.add`, `post.submit`, `comment.delete`) —
namespaced commands that read as the action they perform. The `Effect.fn` span name IS the wire
name.

## Validation lives in the service

Per [ADR 0013](../.decisions/0013-validation-in-service-methods.md), domain validation lives in
the service method, not the protocol layer. The service raises the domain errors
(`BodyRequired`, `BodyTooLong`, `TitleRequired`, …) whose `ErrorCode` annotations become wire
codes ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)); the handler declares them in
its `error` union. The definition's `input` Schema is **shape coercion at the trust boundary**
only — a Schema rejection encodes as `VALIDATION_ERROR` pre-handler. Don't restate domain rules
in the Schema; the service is the single source of truth.

## Returning the changed entity

After the write, the handler returns the changed entity's **shaped row** (the service returns
the fresh row; the feature's shaper maps it to the entity field set). fate masks it to the
client's selection exactly as it masks a read — no hand-shaped responses.

## Delete mutations

A delete returns the affected **parent** entity, re-resolved, so the client's normalized cache
updates the surrounding list. `definition.delete` returns the `Term`; `comment.delete` returns
the `Post`. The returned `type` is the parent, and the selection is the client's requested shape
of it.

## Live events

After the write, a mutation publishes live events through the per-request `LivePublisher`
service so subscribed views update in place:

```ts
const live = yield* LivePublisher;
yield* live.update("Definition", id, {data: definition});                    // entity change
yield* live.connection("Term.definitions", {id: termSlug}).appendNode("Definition", id, {node: definition});
```

Every publish method is `Effect<void>` (`E = never`) — a failed publish cannot fail the
committed mutation; the swallow-with-log lives inside the layer
([fate-effect-server.md](./fate-effect-server.md)). Publish the **already shaped**
entity/node inline as `data`/`node` — the handler shaped it for the response, so the live event
carries resolved data and clients mask it to their own selection. The mutating client still gets
the entity returned directly; live events update *other* clients (and other connections on the
same client). See [fate-live-views.md](./fate-live-views.md).

## See also

- [fate-effect-operations.md](./fate-effect-operations.md) — `Fate.mutation` authoring mechanics
- [fate-effect-wire-errors.md](./fate-effect-wire-errors.md) — the `ErrorCode` annotation codec
- [effect-errors.md](./effect-errors.md) — the domain errors mutations raise
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema` at the input boundary
- [ADR 0013](../.decisions/0013-validation-in-service-methods.md) — validation in service methods
