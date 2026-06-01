# Data views

How types are declared. The short answer: a **data view** per entity — `dataView<Row>("TypeName")({...fields})`. Views are the schema: they describe an entity's shape and which fields a client may select. There is no separate SDL or schema object.

Data views are pure declarations — no Effect, no DB. They describe shape and selection; execution lives in sources ([fate-sources.md](./fate-sources.md)) and resolvers ([fate-mutations.md](./fate-mutations.md)).

## The shape

```ts
// worker/features/fate/views.ts
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

## The local type-derivation helpers (why phoenix doesn't use `Entity<>` directly)

The shape above is the idealized fate API. phoenix's `worker/features/fate/views.ts` can't use `Entity<typeof view, …>` directly because fate boxes its two type-derivation paths against each other across a module boundary:

- **`dataView()`'s inferred return carries an internal symbol** (`dataViewFieldsKey`) that TypeScript can't *name* across a module boundary — an **exported** view must be annotated or `tsgo`'s declaration-nameability check trips **TS2883/TS4023**.
- **The only portable annotation is `SourceDefinition<Item>["view"]`**, but that erases the field map — so `Entity<typeof view, …>` over an annotated view resolves to an empty shape. Neither annotated nor un-annotated exported views yield a usable `Entity<>`.

The fate Vite plugin doesn't need `Entity<>` anyway — it reads the *runtime* view object (`view.typeName`/`view.fields`) for the schema/manifest and imports the entity *type names* (`User`, `Term`, …) verbatim from `views.ts` as the client's view types. So phoenix derives the entity types with three small local helpers instead:

| Helper | What it does |
|---|---|
| `ViewRow<Row>` | `{[K in keyof Row]: Row[K]}` — a homomorphic mapped type over a service row interface, giving it the implicit string index signature `dataView<Item extends Record<string, unknown>>` requires (an interface alone doesn't satisfy it). |
| `DataViewOf<Item>` | `SourceDefinition<Item>["view"]` — the portable, nameable annotation for an **exported** `*DataView` const (dodges TS2883). |
| `EntityOf<Row, Fields, Name>` | Derives the client entity type from the **scalar field selection** (`*Fields` const) the `dataView(...)` call shares, keeping the row's field types while staying nameable (no symbol). |

So each scalar field set is a standalone `*Fields` const passed to `dataView` **and** read by `EntityOf` — one source of truth, no hand-restated fields. Relation fields (`list(...)`) are declared on the exported entity *type* (intersected onto the `EntityOf` result), not in the `*Fields` set: the server attaches each nested connection conditionally as a `ConnectionResult` (only when selected), and the client masks relations into `ViewRef`s through the view selection rather than reading them off the parent. That's why `Term.definitions` / `Post.comments` / `Profile.contributions` are optional (`?`) on their entity types.

## Modeling conventions

- **One `dataView` per entity** (`User`, `Term`, `Definition`, `Post`, `Comment`, `Tag`, `Profile`, …). A summary and a detail view of the same type are two views over the same `Row` (see `postSummaryDataView` vs `postDataView` in the void reference).
- **Connections are `list(view)`, not types.** There are no `Connection`/`Edge`/`PageInfo` types — a list resolves to a `ConnectionResult` at runtime. See [fate-connections.md](./fate-connections.md).
- **Every client-normalized entity MUST expose an `id` field — relations AND root-query entities.** The vite codegen (`createSchema`) builds the client type config from data views only — it emits `{type, fields:{<rel>:{listOf|type}}}` and **never carries a source's `id` field**, so the client hardcodes the default `getId` (reads `record.id`) for every type. Two consequences:
  - **A relation entity keyed by something other than `id`** (e.g. phoenix's `Tag`, keyed by `kind`) throws **`fate: Missing 'id' on entity record.`** the moment the client normalizes a parent that selected it. Model such embedded, non-`id`-keyed collections as a **scalar field** (`tags: true`) instead of `list(view)` — the array passes through verbatim (server → cache) with no per-element normalization, and the client reads it off the parent. phoenix's `Post.tags` is a scalar `{kind,label}[]` for exactly this reason. Keep `list(view)` only for relations whose entity has a real `id` (`Post.comments`, `Term.definitions`, `Profile.contributions`).
  - **A root-query entity read directly by a screen must ALSO carry `id`** — `useRequest({root: {view}})` normalizes the returned record the same way (it isn't only a relation-fetch path). So a view whose row has no natural `id` must add one in the `*Fields` selection and stamp it in the resolver: phoenix's **`Profile`** is keyed by `userId` in the domain, so its view adds `id: true` and `queries.profile` stamps `id === userId` (a `Profile` is one-to-one with its user); **`LandingStats`** is a singleton with no natural id, so its view adds `id: true` and `queries.landingStats` stamps a **constant `id` (`"landing"`)** — there's only ever one row, so it normalizes to a single cache record. Without the stamped `id` the screen's first read throws `Missing 'id' on entity record`.
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
