# Per-feature fate aggregators with barrels

Each feature owns its own fate-shaped fragments (`queries.ts` / `lists.ts` /
`views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts`); the files under
`worker/features/fate/` are **barrels** that compose those fragments into the
single maps fate expects on `createFateServer`. The split is what makes feature
locality (ADR 0036) compatible with fate's "one map per aggregator" wire
contract — and it preserves the SPA's import surface untouched.

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
│   ├── views.ts        # exports `termDataView`, `definitionDataView`, types
│   ├── shapers.ts      # exports `toTerm`, `toDefinition`, ...
│   ├── sources.ts      # exports `termSource`, `termExecutor`, ...
│   └── mutations.ts    # exports `mutations = { "definition.add": ... }`
├── pano/               # same fragments, scoped to pano
├── pasaport/           # same, scoped to pasaport
├── vote/               # mutation-only feature — no queries/lists/views/etc
├── stats/              # query-only feature — only queries.ts/views.ts
└── fate/
    ├── queries.ts      # barrel: spreads sozlukQueries, panoQueries, ...
    ├── lists.ts        # barrel: spreads sozlukLists, panoLists
    ├── views.ts        # barrel + cross-feature `Root`/`LiveEntities`
    ├── shapers.ts      # barrel + the cross-feature `toConnection` envelope
    ├── sources.ts      # barrel + the `{getSource, registry}` surface
    └── mutations.ts    # barrel: spreads sozlukMutations, panoMutations, ...
```

Each barrel is small and mechanical — re-exports plus, where the cross-feature
piece is genuinely cross-feature (e.g. `Root` in `views.ts`, `toConnection` in
`shapers.ts`, the `{getSource, registry}` surface in `sources.ts`), one tiny
piece of composition the per-feature fragments can't own:

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

1. **Fate's wire contract is one map per aggregator.** `createFateServer({queries,
   lists, mutations, sources})` takes a single `queries` object — fate dispatches
   by the request key, not by feature. The barrel is where the per-feature
   fragments collapse into the shape fate expects.
2. **The genuinely cross-feature pieces have a home.** `views.ts` owns `Root`
   (the client-exposed root map, which spans every feature's screens) and
   `LiveEntities` (the entity-name → entity-type registry the live bus types
   against). `shapers.ts` owns the `toConnection` envelope (the keyset-page →
   `ConnectionResult` reshape that every feature uses). `sources.ts` owns the
   `{getSource, registry}` surface fate resolves by `typeName`. None of these
   belong to a single feature; the barrel is where they live.

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
- [fate-effect-worker-wiring.md](./fate-effect-worker-wiring.md) — how the assembled maps
  get handed to `createFateServer`.
- [fate-data-views.md](./fate-data-views.md) — `dataView`/`Entity`/`Root`
  semantics; `Root` is the cross-feature piece in `fate/views.ts`.
- [fate-connections.md](./fate-connections.md) — the `KeysetPage` →
  `ConnectionResult` envelope `toConnection` builds.
- [ADR 0036](../.decisions/0036-features-as-any-named-app-grouping.md) — the
  feature-locality rule that drove the split; this pattern is its fate-layer
  realization.
