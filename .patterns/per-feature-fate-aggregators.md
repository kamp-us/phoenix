# Per-feature fate aggregators with barrels

Each feature owns its own fate-shaped fragments (`queries.ts` / `lists.ts` /
`views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts`); the files under
`worker/features/fate/` are **barrels** that compose those fragments into the
single records (and the one source entry array) `FateServer.config` takes. The
split is what makes feature locality (ADR 0036) compatible with fate's "one map
per aggregator" wire contract — and it preserves the SPA's import surface
untouched.

Read this with [feature-services.md](./feature-services.md) (the per-feature
service shape these fragments orchestrate) and
[fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) (how the assembled maps get
mounted).

## The shape

Two layers:

```
worker/features/
├── sozluk/
│   ├── queries.ts      # exports `queries = { term: ... }`
│   ├── lists.ts        # exports `lists = { recentTerms: ..., popularTerms: ... }`
│   ├── views.ts        # exports `TermView`/`DefinitionView` classes, kernel-view consts, types
│   ├── shapers.ts      # exports `toTerm`, `toDefinition`, ...
│   ├── sources.ts      # exports `termSource`, `definitionSource` (`Fate.source` entries)
│   └── mutations.ts    # exports `mutations = { "definition.add": ... }`
├── pano/               # same fragments, scoped to pano
├── pasaport/           # same, scoped to pasaport
├── vote/               # mutation-only feature — no queries/lists/views/etc
├── stats/              # query-only feature — only queries.ts/views.ts
└── fate/
    ├── queries.ts      # barrel: spreads sozlukQueries, panoQueries, ...
    ├── lists.ts        # barrel: spreads sozlukLists, panoLists
    ├── views.ts        # barrel + cross-feature `Root`/`LiveEntities`
    ├── connection.ts   # leaf: the cross-feature `toConnection`/`KeysetPage` envelope
    ├── sources.ts      # barrel: the features' `Fate.source` entries as the config's array
    └── mutations.ts    # barrel: spreads sozlukMutations, panoMutations, ...
```

Each barrel is small and mechanical — re-exports plus, where the cross-feature
piece is genuinely cross-feature (e.g. `Root` in `views.ts`, the composed
source entry array in `sources.ts`), one tiny piece of composition the
per-feature fragments can't own:

```ts
// worker/features/fate/queries.ts
import {queries as panoQueries} from "../pano/queries.ts";
import {queries as pasaportQueries} from "../pasaport/queries.ts";
import {queries as sozlukQueries} from "../sozluk/queries.ts";
import {queries as statsQueries} from "../stats/queries.ts";

export const queries = {
  ...statsQueries,
  ...pasaportQueries,
  ...sozlukQueries,
  ...panoQueries,
};
```

## What each fragment contains

The per-feature assembly on the `@kampus/fate-effect` constructors — sozluk
(`apps/web/worker/features/sozluk/`) is the shipped reference; pano, pasaport,
and stats follow the same template. The feature's domain service stays
untouched; the fate-facing fragments are:

- **`errors.ts`** — `Schema.TaggedErrorClass`es carrying `{[ErrorCode]: "<CODE>"}`
  annotations ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)), with a
  per-feature `errors.unit.test.ts` enumeration pin.
- **`views.ts`** — `FateDataView<Row>()("Name")({fields})` classes,
  `Entity<typeof View, Replacements>` types, plus kernel-view consts
  (`export const termDataView = TermView.view`) for the `fate/views.ts`
  barrel + `Root` ([fate-effect-data-views.md](./fate-effect-data-views.md)).
- **`sources.ts`** — one `Fate.source(ViewClass, {id}, handlers)` per entity;
  a synthetic entity with no fetch path registers via `Fate.syntheticSource`
  ([fate-effect-sources.md](./fate-effect-sources.md)).
- **`queries.ts` / `lists.ts` / `mutations.ts`** — records of
  `Fate.query`/`Fate.list`/`Fate.mutation` entries, each a pure-data definition
  paired with an `Effect.fn("<wire name>")` handler
  ([fate-effect-operations.md](./fate-effect-operations.md)).
- **`shapers.ts`** — the row → entity field-set mappers the resolvers return
  through.

Two handler conventions hold across every fragment: the per-request services
are `CurrentUser` and `LivePublisher` only ([fate-effect-server.md](./fate-effect-server.md)),
and infra failures die INSIDE the domain service ([feature-services.md](./feature-services.md)
boundary rule) — so no fate-layer file imports `Drizzle` or carries an `orDie`
pipe, and handlers call the services bare.

## The critical property — the SPA's import surface is preserved

The SPA imports `worker/features/fate/views` (and its siblings) without knowing
the split happened. Components reach for `Term`, `Post`, `User`, `Definition`
types from a single import path, and `fate/views.ts` re-exports them from each
feature:

```ts
// worker/features/fate/views.ts
export type {Comment, Post, Tag} from "../pano/views.ts";
export {commentDataView, postDataView, tagDataView} from "../pano/views.ts";
export type {Definition, Term} from "../sozluk/views.ts";
export {definitionDataView, termDataView} from "../sozluk/views.ts";
// ... etc
```

The chunk-3 restructure that moved every fragment per-feature touched **zero**
files under `apps/web/src/`. That's the test: a split that requires the SPA to
chase entity types around the worker tree has leaked the worker's internal
shape into the client. The barrel keeps the seam at one stable path
(`worker/features/fate/views`) and lets the worker reorganize freely behind it.

## When to add a fragment to a feature

Only when the feature actually contributes to that aggregator. Not every
feature has every file:

- **Product domains with reads + writes** (`sozluk/`, `pano/`) carry the full
  set — `queries.ts`, `lists.ts`, `views.ts`, `shapers.ts`, `sources.ts`,
  `mutations.ts`.
- **Mutation-only features** (`vote/`) carry the service (`Vote.ts`) and its
  errors — no fate fragments. Vote is consumed by `Sozluk` and `Pano` as a
  cross-service dep (see `feature-services.md`); it has no resolver surface of
  its own.
- **Query-only features** (`stats/`) carry only `queries.ts` and `views.ts` —
  no `mutations.ts`, no `lists.ts`, no `sources.ts`. The landing-page stats
  card is a single root query backed by a singleton entity.
- **Pasaport** is in between: it has `queries.ts`/`mutations.ts`/`views.ts`/
  `sources.ts`/`shapers.ts` for the fate surface, plus the `Auth` service, the
  `Pasaport` capability, and the better-auth route — its non-fate machinery
  lives in the same folder.

A feature does not invent a `queries.ts` to "complete the set." The presence of
a fragment in a feature is a signal that the feature contributes to that
aggregator; an empty one would be a lie.

## Why the barrels still exist

A reasonable instinct after seeing this is "if every fragment is per-feature,
why does `fate/` exist at all?" Two answers:

1. **The wire contract is one record per aggregator.** `FateServer.config({queries,
   lists, mutations, sources, live})` takes a single `queries` record — dispatch
   is by the request key, not by feature. The barrel is where the per-feature
   fragments collapse into that shape. (The same is true downstream of the
   config: fate's own `createFateServer` — alive only at codegen and as the
   differential oracle's baseline, [fate-effect-compiler.md](./fate-effect-compiler.md) —
   consumes the identical records.)
2. **The genuinely cross-feature pieces have a home.** `views.ts` owns `Root`
   (the client-exposed root map, which spans every feature's screens) and
   `LiveEntities` (the entity-name → entity-type registry the live bus types
   against). `sources.ts` owns the composed source entry **array** the config
   takes — the interpreter resolves entities from it by `typeName`; the
   oracle-baseline compile step builds fate's `{getSource, registry}` from the
   same entries (identity-keyed, so the array holds the features' exported
   objects, never copies). None of these belong to a single feature; the
   barrel is where they live.

A cross-feature **definition** that features import back, however, must NOT
live in a barrel — that's how a barrel becomes a cycle seed. The `toConnection`/
`KeysetPage` envelope used to live in a `fate/shapers.ts` barrel that also
re-exported every feature's shapers; the five feature import sites pulling
`toConnection` transitively loaded *every other* feature's shaper modules. It
now lives in `fate/connection.ts`, a leaf module (imports no feature code,
like `fate/view-types.ts`), and the shapers barrel was deleted — nothing
consumed its re-exports (per-feature shapers are imported directly by their
owning feature).

## When NOT to do this

This pattern is specifically for the **fate aggregators**. Don't generalize it
to "every cross-cutting concern needs barrels." The reason it works here is
that fate's contract is a single map per aggregator, and the worker has
roughly five products contributing — small enough that the barrel doesn't
become its own maintenance burden. A would-be `features/util/index.ts` that
re-exports from every feature's `util.ts` is the
[`shared/`-graveyard pre-emptive rejection](../.decisions/0036-features-as-any-named-app-grouping.md#what-was-considered--rejected)
in different clothing.

## See also

- [feature-services.md](./feature-services.md) — the per-feature service shape
  whose `queries.ts`/`mutations.ts`/`lists.ts` resolvers orchestrate.
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — how the assembled records
  get handed to `FateServer.config` and served.
- [fate-data-views.md](./fate-data-views.md) — `dataView`/`Entity`/`Root`
  semantics; `Root` is the cross-feature piece in `fate/views.ts`.
- [fate-connections.md](./fate-connections.md) — the `KeysetPage` →
  `ConnectionResult` envelope `toConnection` (in `fate/connection.ts`) builds.
- [ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md) — the
  feature-locality rule that drove the split; this pattern is its fate-layer
  realization.
