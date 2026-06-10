# Sources — Effect-backed reads

How fate fetches the data behind a view. The short answer: every entity registers a
`Fate.source(ViewClass, {id}, handlers)` entry whose handlers delegate to the Effect services,
so all read logic (queries, joins, pagination, authorization) stays in the domain layer. fate is
the transport; the services are the domain. **Authoring mechanics live in
[fate-effect-sources.md](./fate-effect-sources.md)** — this doc is the conventions and the
kernel background.

This is the rule that shapes the backend: **fate does not query the database.**
`createDrizzleSourceAdapter` would hit D1 directly and bypass Sozluk/Pano/Vote, re-homing domain
logic into view fields. phoenix never uses it ([ADR 0016](../.decisions/0016-fate-pure-transport-effect-services-domain.md)).
Every read goes through a service method.

## What fate consumes underneath

`createFateServer({sources})` takes a `SourceResolver`:

```ts
type SourceResolver<Context> = {
  getSource: (view: DataView) => SourceDefinition;  // view → its source definition
  registry: SourceRegistry<Context>;                // Map<SourceDefinition, SourceExecutor>
};
```

A `SourceDefinition` is a plain object — `{id, view, orderBy?, relations?}` — where `id` is the
row's primary-key field name. A `SourceExecutor` is `{byId?, byIds?, connection?}`: async
handlers returning **raw domain rows**, which fate masks/shapes to the view+selection afterward.
The registry is identity-keyed — fate looks an executor up by the object identity of the
`SourceDefinition` that `getSource` returns.

phoenix code never builds this resolver by hand anymore — and since the v2 cutover (ADR 0043)
the serving path doesn't build it at all: the interpreter resolves sources from the config's
entry array directly ([fate-effect-interpreter.md](./fate-effect-interpreter.md)).
`@phoenix/fate-effect`'s compile step (`compileFateSources`,
[fate-effect-compiler.md](./fate-effect-compiler.md)) still builds the `{getSource, registry}`
pair from the composed `Fate.source` entries for the differential oracle's baseline
(`worker/features/fate/sources.ts` is the array of the features' exported entries — never
copies, because the registry is identity-keyed).

## No `connection` executors — keyset order lives in the service

Sources carry **no** `connection` executor and no `orderBy` contract: every connection — root
*and* nested — is delivered by a custom resolver in `queries.ts`/`lists.ts` calling the service
keyset method directly ([ADR 0019](../.decisions/0019-connection-pagination-strategy.md)). The
keyset `ORDER BY` lives in the service; the view's `FateDataView.list(View, {orderBy})` mirrors
it. See [fate-connections.md](./fate-connections.md).

## byIds is the workhorse; batch it

fate calls `byId` for single fetches and `byIds` when resolving a relation across many parents.
**Implement `byIds`** — without it fate falls back to N× `byId`, the N+1 the normalized cache
exists to avoid. The service exposes `getXsByIds(ids)`: a `WHERE id IN (...)` over the existing
read path. Order doesn't matter — fate re-associates by `id`. (Under the v2 native interpreter,
`byIds` is also what `RequestResolver` batching rides on.)

## Where each type's data comes from

| View | Service | Notes |
|---|---|---|
| `Term`, `Definition` | `Sozluk` | `definitionCount` via the service row |
| `Post`, `Comment`, `Tag` | `Pano` | `Tag` is a pure kind→label map (no DB) |
| `User`, `Profile` | `Pasaport` | `User.byIds` is the hottest path (authors everywhere) |
| `Contribution` | — | synthetic; capability-less entry, rows exist only in `queries.profile`'s reshape |

Vote/karma stay inside Sozluk/Pano (which delegate to `Vote`) — there is no fate view for votes;
scores surface as fields on the entity that owns them.

## See also

- [fate-effect-sources.md](./fate-effect-sources.md) — `Fate.source` authoring (loader contract, spans, the capability-less escape hatch)
- [fate-effect-compiler.md](./fate-effect-compiler.md) — how the entries compile to fate's `{getSource, registry}`
- [fate-connections.md](./fate-connections.md) — pagination ownership (ADR 0019)
