# Per-feature fate modules + the root merge

Each feature owns its own fate-shaped fragments (`queries.ts` / `lists.ts` /
`views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts`) and bundles its whole
operation surface into one **`fate-module.ts`** manifest. The composition root
(`worker/features/fate/config.ts`) consumes a flat array of those manifests and
merges them once (`fate/module.ts`'s `mergeFateModules`) into the single records
(and source array) `FateServer.config` takes. The split is what makes feature
locality (ADR 0036) compatible with fate's "one map per aggregator" wire
contract — and it preserves the SPA's import surface untouched.

`views.ts` is the one remaining **barrel** under `worker/features/fate/`: it
re-exports every feature's entity types + view consts so the SPA imports from one
stable path. The client-exposed `Root` map is **not** hand-listed there — each
feature owns its slice on its `fate-module.ts` (`roots`), and `views.ts` derives
`Root` from the same `config.ts` registry that drives the served config
(`mergeFateRoots(modules)`), so a feature's roots are named **once** (on its
module), not twice (barrel re-export + a parallel `Root` entry — the double-listing
collapse, [issue #1338](https://github.com/kamp-us/phoenix/issues/1338)). The three
operation barrels (`queries.ts` / `lists.ts` / `mutations.ts`) and the `sources.ts`
barrel are gone — registering a feature is now one array entry in `config.ts`, not a
spread line per central barrel (the registration-friction collapse,
[issue #1034](https://github.com/kamp-us/phoenix/issues/1034)).

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
│   ├── mutations.ts    # exports `mutations = { "definition.add": ... }`
│   └── fate-module.ts  # bundles this feature's {queries, lists, mutations, sources, roots}
├── pano/               # same fragments + fate-module.ts, scoped to pano
├── pasaport/           # same, scoped to pasaport
├── vote/               # mutation-only feature — no fate fragments, no module
├── stats/              # query-only feature — queries.ts/views.ts + a {queries, roots} module
└── fate/
    ├── module.ts       # the `FateModule` type + `mergeFateModules`/`mergeFateRoots` (the root merges)
    ├── config.ts       # exports + registers the `modules` array, merges, adds `live`
    ├── views.ts        # type/view barrel + `Root = mergeFateRoots(modules)` + `LiveEntities`
    └── connection.ts   # leaf: the cross-feature `toConnection`/`KeysetPage` envelope
```

Each feature's `fate-module.ts` is small and mechanical — it imports the
feature's own fragments and names them in one value:

```ts
// worker/features/sozluk/fate-module.ts
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {definitionSource, termSource} from "./sources.ts";
import {termDataView} from "./views.ts";

// This feature's slice of the client `Root` map — declared next to the views it
// composes (FateRootsRecord = Record<string, unknown>, to keep the dataView symbol
// off the module export, TS2883/TS4023).
const roots: FateRootsRecord = {
  term: termDataView,
  recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
  popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
  landingTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
};

export const fateModule = {
  queries,
  lists,
  mutations,
  sources: [definitionSource, termSource],
  roots,
} satisfies FateModule;
```

`satisfies FateModule` (not a `: FateModule` annotation) keeps each module's
precise entry types so the root's R-channel math infers exactly as the
hand-written barrels did. The composition root then lists the modules once:

```ts
// worker/features/fate/config.ts — `modules` is exported so `views.ts` derives `Root` off it
export const modules = [statsModule, pasaportModule, sozlukModule, panoModule, searchModule, reportModule, divanModule];

export const fateConfig = FateServer.config({
  ...mergeFateModules(modules),
  live: liveBusConfig,
});
```

`mergeFateModules` is generic over the modules tuple: it spreads the
`queries`/`lists`/`mutations` records (so the merged type is their intersection)
and concatenates the `sources` arrays (a union of source-entry types). Order is
not load-bearing — fate's registry is keyed by entry identity, and
`collectConfigIssues` flags duplicate wire names / duplicate sources regardless
of order — so the merged value resolves identically to the old per-category
barrels. (`Codegen.test.ts`'s manifest-parity invariant and the worker's
`wireCodes.unit.test.ts` pin that identity.)

## What each fragment contains

The per-feature assembly on the `@kampus/fate-effect` constructors — sozluk
(`apps/web/worker/features/sozluk/`) is the shipped reference; pano, pasaport,
and stats follow the same template. The feature's domain service stays
untouched; the fate-facing fragments are:

- **`errors.ts`** — `Schema.TaggedErrorClass`es carrying `{[FateWireCode]: "<CODE>"}`
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
- **`fate-module.ts`** — the manifest bundling this feature's operation records
  + source array + its `roots` (the feature's slice of the client `Root` map,
  declared next to the views it composes) into one `FateModule` the root registers.
  Annotate `roots` as `Record<string, unknown>` (`FateRootsRecord`) so the `dataView`
  symbol doesn't surface across the module export (TS2883/TS4023).

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

The restructure that moved every fragment per-feature touched **zero** files
under `apps/web/src/`. That's the test: a split that requires the SPA to chase
entity types around the worker tree has leaked the worker's internal shape into
the client. The `views.ts` barrel keeps the seam at one stable path
(`worker/features/fate/views`) and lets the worker reorganize freely behind it.

## When to add a fragment to a feature

Only when the feature actually contributes to that aggregator. Not every
feature has every file, and `fate-module.ts` names only the fragments it has:

- **Product domains with reads + writes** (`sozluk/`, `pano/`) carry the full
  set — `queries.ts`, `lists.ts`, `views.ts`, `shapers.ts`, `sources.ts`,
  `mutations.ts`, `fate-module.ts`.
- **Mutation-only features** (`vote/`) carry the service (`Vote.ts`) and its
  errors — no fate fragments, no module. Vote is consumed by `Sozluk` and `Pano`
  as a cross-service dep (see `feature-services.md`); it has no resolver surface
  of its own.
- **Query-only features** (`stats/`) carry only `queries.ts` and `views.ts` —
  no `mutations.ts`, no `lists.ts`, no `sources.ts`. Its `fate-module.ts` is just
  `{queries, roots} satisfies FateModule` (the `landingStats` root slice).
- **Search** is lists-only among the operation records (`{lists, roots}` — its
  `searchTerms`/`searchPosts` root slice); **report** is lists + mutations +
  synthetic sources, no queries. Every field on `FateModule` is optional for
  exactly this reason.
- **Pasaport** is in between: `queries.ts`/`mutations.ts`/`views.ts`/
  `sources.ts`/`shapers.ts` for the fate surface (no `lists.ts`), plus the
  `Auth` service, the `Pasaport` capability, and the better-auth route — its
  non-fate machinery lives in the same folder.

A feature does not invent a `queries.ts` to "complete the set." The presence of
a fragment in a feature — and of its key in the `fateModule` — is a signal that
the feature contributes to that aggregator; an empty one would be a lie.

## Adding a fate entity — the reduced surface

The point of the module manifest: adding an entity to a feature that already
contributes touches only the feature's own files (its `views.ts` / `sources.ts`
/ the relevant operation record). The feature's `fate-module.ts` already names
those records, so the new entry flows into the merged config without any edit
under `fate/`. Registering a *new* feature is one array entry in `config.ts` —
not a spread line added to each of four central barrels. (Before #1034, an entity
was a ~8-file barrel ritual; the operation/source barrels were the registry tax.)

## Why the merge (and the `views.ts` barrel) still exist

A reasonable instinct is "if every fragment is per-feature, why does `fate/`
compose at all?" Two answers:

1. **The wire contract is one record per aggregator.** `FateServer.config({queries,
   lists, mutations, sources, live})` takes a single `queries` record — dispatch
   is by the request key, not by feature. `mergeFateModules` is where the
   per-feature manifests collapse into that shape. (The same records feed fate's
   own `createFateServer` at codegen and as the differential oracle's baseline,
   [fate-effect-compiler.md](./fate-effect-compiler.md).)
2. **The genuinely cross-feature pieces have a home.** `views.ts` assembles `Root`
   (the client-exposed root map, which spans every feature's screens — now
   `mergeFateRoots(modules)` over each feature's own `roots`, not a hand-listed map)
   and `LiveEntities` (the entity-name → entity-type registry the live bus types
   against). Neither belongs to a single feature; the `views.ts` barrel is where the
   assembly lives, even though the per-feature slices that feed it live on the modules.

A cross-feature **definition** that features import back, however, must NOT
live in a barrel — that's how a barrel becomes a cycle seed. The `toConnection`/
`KeysetPage` envelope used to live in a `fate/shapers.ts` barrel that also
re-exported every feature's shapers; the feature import sites pulling
`toConnection` transitively loaded *every other* feature's shaper modules. It
now lives in `fate/connection.ts`, a leaf module (imports no feature code, like
`fate/view-types.ts`). The per-feature `fate-module.ts` files are the inverse —
each imports only its own feature's fragments, so they seed no cross-feature
cycle; only `config.ts` fans in across features.

## When NOT to do this

This pattern is specifically for the **fate aggregators**. Don't generalize the
manifest-and-merge to "every cross-cutting concern needs a module registry." The
reason it works here is that fate's contract is a single map per aggregator, and
the worker has roughly five products contributing — small enough that the merge
is one line of composition. A would-be `features/util/index.ts` that re-exports
from every feature's `util.ts` is the
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
