# Sources — Effect-backed reads

How fate fetches the data behind a view. The short answer: phoenix hand-builds a `SourceResolver` whose executors delegate to the Effect services, so all read logic (queries, joins, pagination, authorization) stays in the domain layer. fate is the transport; the services are the domain.

This is the rule that shapes the backend: **fate does not query the database.** `createDrizzleSourceAdapter` would hit D1 directly and bypass Sozluk/Pano/Vote, re-homing domain logic into view fields. phoenix never uses it. Every read goes through a service method.

## What `createFateServer` needs

`createFateServer({sources})` takes a `SourceResolver`:

```ts
type SourceResolver<Context> = {
  getSource: (view) => SourceDefinition;        // view → its source definition
  registry: SourceRegistry<Context>;            // Map<SourceDefinition, SourceExecutor>
};
```

A `SourceExecutor` is `{byId?, byIds?, connection?}` — async handlers returning **raw domain rows**. fate masks/shapes them to the view+selection afterward. All three pieces are built from public exports.

## Building the resolver

```ts
// worker/fate/sources.ts
import {
  createSourceDefinition,
  createSourceRegistry,
  getBaseDataView,
  getDataViewSourceConfig,
  type DataView,
  type SourceDefinition,
  type SourceExecutor,
} from "@nkzw/fate/server";
import {fateSource} from "./effect";              // the Effect bridge
import {termDataView, definitionDataView, userDataView} from "./views";

// One SourceExecutor per type, delegating to a service. fateSource wraps each
// generator in the request runtime (see fate-effect-bridge.md).
const termExecutor = fateSource<TermSummaryRow>({
  byIds: function* (ids) {
    const sozluk = yield* Sozluk;
    return yield* sozluk.getTermsByIds(ids);
  },
});

const definitionExecutor = fateSource<DefinitionRow>({
  byIds: function* (ids) {
    const sozluk = yield* Sozluk;
    return yield* sozluk.getDefinitionsByIds(ids);
  },
});

// Register [view, executor] pairs. The base view (unwrapping list()) is the key.
const entries: Array<[DataView<any>, SourceExecutor<FateContext, any>]> = [
  [termDataView, termExecutor],
  [definitionDataView, definitionExecutor],
  [userDataView, userExecutor],
  // …one per type fetched by id or appearing as a relation…
];

const definitions = new Map<DataView<any>, SourceDefinition>(
  entries.map(([view]) => [getBaseDataView(view), createSourceDefinition(getDataViewSourceConfig(view))]),
);

export const sources = {
  getSource: (target: DataView<any> | SourceDefinition) =>
    "view" in target && "id" in target ? target : definitions.get(getBaseDataView(target as DataView<any>))!,
  registry: createSourceRegistry(
    entries.map(([view, executor]) => [definitions.get(getBaseDataView(view))!, executor]),
  ),
};
```

`getDataViewSourceConfig(view)` derives `{view, orderBy}` from the view's `list()` options; `createSourceDefinition` turns that into the `SourceDefinition` fate keys executors by. Every type reachable as a relation needs an entry — a type with no executor throws `No executor registered` at query time.

## byIds is the workhorse; batch it

fate calls `byId` for single fetches and `byIds` when resolving a relation across many parents. **Implement `byIds`** — without it fate falls back to N× `byId`, the N+1 the normalized cache exists to avoid. The service exposes `getXsByIds(ids)`: a `WHERE id IN (...)` over the existing read path. Order doesn't matter — fate re-associates by `id`.

## Where each type's data comes from

| View | Service | Notes |
|---|---|---|
| `Term`, `Definition` | `Sozluk` | `definitionCount` via `computed`+`count` or a service field |
| `Post`, `Comment`, `Tag` | `Pano` | |
| `User`, `Profile` | `Pasaport` | `User.byIds` is the hottest path (authors everywhere) |

Vote/karma stay inside Sozluk/Pano (which delegate to `Vote`) — there is no fate view for votes; scores surface as fields on the entity that owns them.

## Reads and writes share the source

Mutation resolvers re-resolve the changed entity through the same source (`createSourcePlan(...).resolve(row)`), so a write's response is masked identically to a read. See [fate-mutations.md](./fate-mutations.md).

## See also

- [fate-effect-bridge.md](./fate-effect-bridge.md) — `fateSource`, the runtime, error mapping
- [fate-data-views.md](./fate-data-views.md) — the views these sources back
- [fate-connections.md](./fate-connections.md) — the `connection` executor and cursors
- [feature-services.md](./feature-services.md) — the services the executors call
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/server.ts` (note: it uses the Drizzle adapter — phoenix deliberately does not)
