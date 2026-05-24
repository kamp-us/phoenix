# Data views

How types are declared. The short answer: a **data view** per entity — `dataView<Row>("TypeName")({...fields})`. Views are the schema: they describe an entity's shape and which fields a client may select. There is no separate SDL or schema object.

Data views are pure declarations — no Effect, no DB. They describe shape and selection; execution lives in sources ([fate-sources.md](./fate-sources.md)) and resolvers ([fate-mutations.md](./fate-mutations.md)).

## The shape

```ts
// worker/fate/views.ts
import {computed, count, dataView, field, list, type Entity} from "@nkzw/fate/server";
import type {TermSummaryRow, DefinitionRow} from "../features/sozluk/Sozluk";

export const userDataView = dataView<UserRow>("User")({
  id: true,
  username: true,
  displayName: true,
});

export const definitionDataView = dataView<DefinitionRow>("Definition")({
  id: true,
  body: true,
  score: true,
  author: userDataView,        // relation → another view
});

export const termDataView = dataView<TermSummaryRow>("Term")({
  id: true,
  slug: true,
  title: true,
  totalScore: true,
  definitionCount: computed<TermSummaryRow, number>({
    resolve: (_item, deps) => (deps.count as number) ?? 0,
    select: {count: count("definitions")},
  }),
});

export type Term = Entity<typeof termDataView, "Term", {definitions: Array<Definition>}>;
export type Definition = Entity<typeof definitionDataView, "Definition", {author: User}>;
export type User = Entity<typeof userDataView, "User">;
```

Field selection vocabulary:

| Form | Use for |
|---|---|
| `field: true` | plain scalar columns |
| `field: anotherDataView` | a single related entity |
| `field: list(view, {orderBy})` | a related collection / connection |
| `computed<Row, T>({resolve, select})` | a derived value (counts, formatted fields) |
| `count("relation", {where})` | an aggregate count, used as a `computed` dep |
| `resolver({resolve, authorize})` | a field with per-field authorization / masking |

## Selection masking is the authorization surface

The client sends a flat list of dotted paths (`["id", "title", "author.username"]`). fate resolves only those, then **masks the result down to what the view allows** — a client cannot select a field the view didn't declare, and `authorize` on a `computed`/`resolver` field returns `null` when the caller isn't permitted. The view is the field-level authorization boundary; treat adding a field to a view as exposing it.

## `Entity<>` is the shared type

`Entity<typeof view, "TypeName", {relations}>` derives the row type a resolved view produces, including `__typename`. These exported types are what the client imports (type-only) and what codegen reads. The server is the single source of truth for types — there is no schema artifact to keep in sync. See [fate-server-wiring.md](./fate-server-wiring.md) for codegen.

## Modeling conventions

- **One `dataView` per entity** (`User`, `Term`, `Definition`, `Post`, `Comment`, `Tag`, `Profile`, …). A summary and a detail view of the same type are two views over the same `Row` (see `postSummaryDataView` vs `postDataView` in the void reference).
- **Connections are `list(view)`, not types.** There are no `Connection`/`Edge`/`PageInfo` types — a list resolves to a `ConnectionResult` at runtime. See [fate-connections.md](./fate-connections.md).
- **Any entity is fetchable by `(type, id)`** through its source's byId handler. There is no `Node` interface or `node(id)` dispatch — the operation carries the type.
- **IDs are raw per-type values.** The protocol carries `type` and `id` on every operation, so IDs need no global encoding. Don't base64 a typename into the id.
- **Heterogeneous feeds use a discriminant, not a union.** fate has no union type. A profile's mixed contributions feed is a view with a `kind` field the client switches on (or separate lists per branch).
- **Enum-style args are plain strings** validated where they're consumed (`sort: "recent" | "popular"`), not declared enum types.

## See also

- [fate-sources.md](./fate-sources.md) — how a view's data is fetched
- [fate-connections.md](./fate-connections.md) — `list(view)` and pagination
- [fate-mutations.md](./fate-mutations.md) — returning an `Entity` from a write
- [effect-schema-validation.md](./effect-schema-validation.md) — validating the inputs that reach resolvers
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/views.ts`
