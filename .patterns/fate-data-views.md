# Data views

How entity types are modeled. The short answer: a **data view** per entity — in phoenix, a
`FateDataView<Row>()("Name")({fields})` class whose static `view` IS the kernel `dataView()`
value ([fate-effect-data-views.md](./fate-effect-data-views.md) owns the authoring mechanics
and the TS2883 story; this doc is the modeling conventions). Views are the schema: they
describe an entity's shape and which fields a client may select. There is no separate SDL or
schema object.

Data views are pure declarations — no Effect, no DB. They describe shape and selection;
execution lives in sources ([fate-effect-sources.md](./fate-effect-sources.md)) and operations
([fate-effect-operations.md](./fate-effect-operations.md)). Per-feature views live in their
owning feature (`features/<feature>/views.ts` — sozluk's is the reference);
`worker/features/fate/views.ts` is the re-export barrel plus the cross-feature `Root` map
([per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md)).

## Field selection vocabulary

The field map is fate's own config vocabulary, passed through the class factory untouched:

| Form | Use for |
|---|---|
| `field: true` | plain scalar columns (including pre-stamped values like `myVote`) |
| `field: anotherDataView` | a single related entity |
| `field: FateDataView.list(View, {orderBy})` | a related collection / connection |
| `computed<Row, T>({resolve, select})` | a derived value (counts, formatted fields) |
| `count("relation", {where})` | an aggregate count, used as a `computed` dep |
| `resolver({resolve, authorize})` | a field with per-field authorization / masking |

## Selection masking is the authorization surface

The client sends a flat list of dotted paths (`["id", "title", "author.username"]`). fate resolves only those, then **masks the result down to what the view allows** — a client cannot select a field the view didn't declare, and `authorize` on a `computed`/`resolver` field returns `null` when the caller isn't permitted. The view is the field-level authorization boundary; treat adding a field to a view as exposing it.

## `Entity<>` is the shared type

`Entity<typeof View, Replacements>` derives the row type a resolved view produces, including `__typename`. These exported types are what the client imports (type-only) and what codegen reads — the server is the single source of truth for types; there is no schema artifact to keep in sync ([fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) covers codegen). The `Replacements` conventions (list relations, `Date` restatement) are in [fate-effect-data-views.md](./fate-effect-data-views.md). The one local helper is `ViewRow<Row>` (`worker/features/fate/view-types.ts`) — the homomorphic mapped type that gives a service row interface the implicit index signature the `Record<string, unknown>` item bound requires.

## Modeling conventions

- **One view per entity** (`User`, `Term`, `Definition`, `Post`, `Comment`, `Profile`, …). A summary and a detail view of the same type are two views over the same `Row` (see `postSummaryDataView` vs `postDataView` in the void reference).
- **Connections are `FateDataView.list(view, {orderBy})`, not types.** There are no `Connection`/`Edge`/`PageInfo` types — a list resolves to a `ConnectionResult` at runtime. See [fate-connections.md](./fate-connections.md).
- **Every client-normalized entity MUST expose an `id` field — relations AND root-query entities.** The vite codegen (`createSchema`) builds the client type config from data views only — it emits `{type, fields:{<rel>:{listOf|type}}}` and **never carries a source's `id` field**, so the client hardcodes the default `getId` (reads `record.id`) for every type. Two consequences:
  - **A relation entity keyed by something other than `id`** (e.g. phoenix's `Tag`, keyed by `kind`) throws **`fate: Missing 'id' on entity record.`** the moment the client normalizes a parent that selected it. Model such embedded, non-`id`-keyed collections as a **scalar field** (`tags: true`) instead of a list relation — the array passes through verbatim (server → cache) with no per-element normalization, and the client reads it off the parent. phoenix's `Post.tags` is a scalar `{kind,label}[]` for exactly this reason. Keep list relations only for entities with a real `id` (`Post.comments`, `Term.definitions`, `Profile.contributions`).
  - **A root-query entity read directly by a screen must ALSO carry `id`** — `useRequest({root: {view}})` normalizes the returned record the same way (it isn't only a relation-fetch path). So a view whose row has no natural `id` must add one in the `*Fields` selection and stamp it in the resolver: phoenix's **`Profile`** is keyed by `userId` in the domain, so its view adds `id: true` and `queries.profile` stamps `id === userId` (a `Profile` is one-to-one with its user); **`LandingStats`** is a singleton with no natural id, so its view adds `id: true` and `queries.landingStats` stamps a **constant `id` (`"landing"`)** — there's only ever one row, so it normalizes to a single cache record. Without the stamped `id` the screen's first read throws `Missing 'id' on entity record`.
- **Any entity is fetchable by `(type, id)`** through its source's byId handler. There is no `Node` interface or `node(id)` dispatch — the operation carries the type.
- **IDs are raw per-type values.** The protocol carries `type` and `id` on every operation, so IDs need no global encoding. Don't base64 a typename into the id.
- **Heterogeneous feeds use a discriminant, not a union.** fate has no union type. A profile's mixed contributions feed is a view with a `kind` field the client switches on (or separate lists per branch).
- **Enum-style args are plain strings** validated where they're consumed (`sort: "recent" | "popular"`), not declared enum types.

## See also

- [fate-effect-data-views.md](./fate-effect-data-views.md) — the `FateDataView` class factory, `Entity<>`/`Replacements`, why raw `dataView()` exports are banned (TS2883)
- [fate-effect-sources.md](./fate-effect-sources.md) — how a view's data is fetched
- [fate-connections.md](./fate-connections.md) — list relations and pagination
- [fate-effect-operations.md](./fate-effect-operations.md) — returning an `Entity` from a write
- [effect-schema-validation.md](./effect-schema-validation.md) — validating the inputs that reach resolvers
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/views.ts`
