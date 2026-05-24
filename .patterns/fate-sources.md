# Sources — Effect-backed reads

How fate fetches the data behind a view. The short answer: phoenix hand-builds a `SourceResolver` whose executors delegate to the Effect services, so all read logic (queries, joins, pagination, authorization) stays in the domain layer. fate is the transport; the services are the domain.

This is the rule that shapes the backend: **fate does not query the database.** `createDrizzleSourceAdapter` would hit D1 directly and bypass Sozluk/Pano/Vote, re-homing domain logic into view fields. phoenix never uses it. Every read goes through a service method.

## What `createFateServer` needs

`createFateServer({sources})` takes a `SourceResolver`:

```ts
type SourceResolver<Context> = {
  getSource: (view: DataView) => SourceDefinition;  // view → its source definition
  registry: SourceRegistry<Context>;                // Map<SourceDefinition, SourceExecutor>
};
```

A `SourceDefinition` is a plain object — `{id, view, orderBy?, relations?}` — where `id` is the row's primary-key field name. A `SourceExecutor` is `{byId?, byIds?, connection?}`: async handlers returning **raw domain rows**, which fate masks/shapes to the view+selection afterward. `SourceRegistry` is just `Map<SourceDefinition, SourceExecutor>` — fate looks an executor up by the **object identity** of the `SourceDefinition` that `getSource` returns.

> **fate v1.0.3 exports the source *types*, not the builders.** The helpers `createSourceDefinition`, `getDataViewSourceConfig`, `createSourceRegistry`, and `getBaseDataView` exist inside fate but are **not re-exported** from `@nkzw/fate/server`; the only public way to auto-derive a source is `createDrizzleSourceAdapter`, which phoenix bans (ADR 0016). So phoenix builds the three pieces directly — the `SourceDefinition` as an object literal, the registry as a `new Map`, and `getSource` as a `typeName` lookup. This needs no fork or patch, and keeps ordering explicit in the service (ADR 0019).

## Building the resolver

```ts
// worker/fate/sources.ts
import type {DataView, SourceDefinition, SourceExecutor} from "@nkzw/fate/server";
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

// A SourceDefinition is a plain object literal — no factory call. `id` is the PK
// field name, `view` is the *base* data view, `orderBy` matches the service
// ORDER BY for connections (ADR 0019), `relations` wires nested connections.
const termSource: SourceDefinition<TermSummaryRow> = {id: "id", view: termDataView};
const definitionSource: SourceDefinition<DefinitionRow> = {
  id: "id",
  view: definitionDataView,
  orderBy: [{field: "createdAt", direction: "desc"}], // = Sozluk's ORDER BY; id is the tiebreaker
};
const userSource: SourceDefinition<UserRow> = {id: "id", view: userDataView};

// The registry is a plain Map keyed by the SourceDefinition object (identity).
const registry = new Map<SourceDefinition<any>, SourceExecutor<FateContext, any>>([
  [termSource, termExecutor],
  [definitionSource, definitionExecutor],
  [userSource, userExecutor],
  // …one entry per type fetched by id or appearing as a relation…
]);

// fate calls getSource with either a base view or a list()-wrapped root view;
// both share `typeName` (list() spreads the base view), so resolve by typeName.
// It must return the *same* SourceDefinition object used as the registry key.
const sourcesByType = new Map<string, SourceDefinition<any>>(
  [termSource, definitionSource, userSource].map((s) => [s.view.typeName, s]),
);

export const sources = {
  getSource: (view: DataView<any>) => sourcesByType.get(view.typeName)!,
  registry,
};
```

Every type reachable as a relation needs an entry — a type with no executor throws `No executor registered for source <Type>` at query time. Order doesn't matter in `byIds`; fate re-associates rows by `id`.

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
