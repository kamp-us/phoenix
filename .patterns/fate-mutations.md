# Mutations

How writes work. The short answer: a `mutations` map on `createFateServer`, each entry `{type, input?, resolve}`. The `resolve` is a `fateMutation(function* …)` that calls a domain service to perform the write, then **re-resolves the affected entity** so the response is shaped exactly like a read.

## The shape

```ts
// worker/fate/server.ts
mutations: {
  "definition.add": {
    type: "Definition",                       // entity type returned (for client cache)
    resolve: fateMutation(function* ({input, select}: {input: AddDefinitionInput; select}) {
      const {user} = yield* Auth.required;     // → UNAUTHORIZED on failure
      const sozluk = yield* Sozluk;
      const id = yield* sozluk.addDefinition({...input, actorId: user.id});
      return yield* resolveEntity(definitionDataView, id, select);  // shape == a read
    }),
  },
},
```

Operation names are **`entity.verb`** (`definition.add`, `post.submit`, `comment.delete`) — namespaced commands that read as the action they perform.

## Validation lives in the service

Per ADR 0013, input validation lives in the service method, not the protocol layer. The service raises the domain errors (`BodyRequired`, `BodyTooLong`, `TitleRequired`, …) that `encodeFateError` maps to wire codes ([fate-effect-bridge.md](./fate-effect-bridge.md)). fate's optional `input` schema (Standard Schema / zod) is only for **shape coercion at the trust boundary** — keep it thin or omit it. Don't restate domain rules in the resolver; the service is the single source of truth.

## Re-resolving the entity

After the write, shape the changed row through the source plan so masking and relations match a normal read:

```ts
import {createSourcePlan} from "@nkzw/fate/server";
import {sources} from "./sources";

function* resolveEntity<Item>(view, id: string, select: ReadonlyArray<string>) {
  const row = yield* /* service.getXById(id) */;
  if (!row) return yield* new FateRequestError("NOT_FOUND", "Not found.");
  const plan = createSourcePlan({ctx, select: [...select], source: sources.getSource(view)});
  return yield* Effect.promise(() => plan.resolve(row));
}
```

`resolveSourceById` from `@nkzw/fate/server` does the same fetch-through-executor + shape in one call; wrap whichever you prefer once and reuse it across mutations.

## Delete mutations

A delete returns the affected **parent** entity, re-resolved, so the client's normalized cache updates the surrounding list. `definition.delete` returns the `Term`; `comment.delete` returns the `Post`. The returned `type` is the parent, and `select` is the client's requested shape of it.

## Live events

A mutation may publish live events (`live.connection(...).appendNode(...)`, `live.update(...)`) for views subscribed over SSE. phoenix does not enable live views — fate's built-in event bus is single-isolate in-memory, so enabling them requires a Durable-Object-backed `LiveEventBus`. Until then, mutations return the re-resolved entity and the client refetches as needed.

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — `fateMutation` and `encodeFateError`
- [fate-sources.md](./fate-sources.md) — re-resolving via the source
- [effect-errors.md](./effect-errors.md) — the domain errors mutations raise
- [effect-schema-validation.md](./effect-schema-validation.md) — `Schema.Class` at the input boundary
- ADR 0013 — validation in service methods
