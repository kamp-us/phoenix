# fate-effect server — `FateServer` tag, `config`, `layer`, and the per-request pair

How `@phoenix/fate-effect` composes a fate server. The short answer: **fate has exactly one composite — the server — so it is the one Effect service.** `FateServer` is the package-owned tag (the `HttpRouter` idiom; no user-defined class), `FateServer.config(...)` captures the records, and `FateServer.layer(config)` is the only composition construct — domain requirements are discharged with ordinary `Layer.provide`. There is no menu, fragment, group, or per-feature tag. Entries are authored per [fate-effect-operations.md](./fate-effect-operations.md) and [fate-effect-sources.md](./fate-effect-sources.md).

## Declaring a server

```ts
import {FateServer} from "@phoenix/fate-effect";
import {Layer} from "effect";
import {panoLists, panoMutations, panoQueries, panoSources} from "../pano/fate.ts";
import {sozlukLists, sozlukMutations, sozlukQueries, sozlukSources} from "../sozluk/fate.ts";

export const fateConfig = FateServer.config({
	queries: {...sozlukQueries, ...panoQueries},
	lists: {...sozlukLists, ...panoLists},
	mutations: {...sozlukMutations, ...panoMutations},
	sources: [...sozlukSources, ...panoSources],
	live: liveBusConfig,
});

export const FateServerLive = FateServer.layer(fateConfig).pipe(
	Layer.provide([SozlukLive, PanoLive]),
);
```

- `config` mirrors `createFateServer`'s options shape. `queries`/`lists`/`mutations` are fate's records (dotted wire names → entries); `sources` is an **array** of `Fate.source` entries (the package's one deviation: fate's own `sources` option is the derived `{getSource, registry}` resolver, which the compile step builds — task 7 — keying the registry by the definition objects' identity). `live` passes through to fate unchanged.
- `config` is **pure data capture** — full entry types are preserved on the value (`InferFateAPI`/codegen fidelity rides on them); all validation happens at layer construction.
- `FateServer.layer(config)` returns `Layer<FateServer, never, R>` where **R is the union of every handler's and source's requirements** (Schema decoding services included) **minus the per-request pair**. A forgotten domain layer is a compile error where the layer is consumed (e.g. `ManagedRuntime.make`), because the undischarged layer is not a `Layer<FateServer>`.

## The per-request pair: `CurrentUser` and `LivePublisher`

The server's documented per-request contract (PRD stories 8–9). Handlers `yield*` them like any other service:

```ts
Effect.fn("definition.add")(function* ({input}) {
	const user = yield* CurrentUser.required; // fails Unauthorized → UNAUTHORIZED on the wire
	const live = yield* LivePublisher;
	const definition = yield* sozluk.addDefinition({...input, userId: user.id});
	yield* live.connection("Term.definitions", {slug: input.termSlug}).appendNode("Definition", definition.id, {node: definition});
	return definition;
})
```

but **no worker-level layer ever provides them**: the compile step provides the pair onto each handler per request (`CurrentUser` from the session, `LivePublisher` from the request's execution context) and `FateServerRequirements` excludes both from the layer's R. This is what makes the bridge's `FateContext` smuggling unnecessary. `LivePublisher`'s publish methods are typed `Effect<void>` — waitUntil scheduling and error-swallowing live inside its layer (task 6), once, so "a publish cannot fail the mutation" is a type, not a `useIgnore` convention.

## Init-time validation (dies at layer construction, names attached)

`FateServer.layer` dies with a `FateServerConfigError` (a defect — composition mistakes are programmer errors; E stays `never`) listing every problem at once:

- **Duplicate wire names across the category records** — `duplicate wire name "term" — declared by queries["term"] and lists["term"]`. Within ONE record, spread collapses duplicate keys before any code can see them (fate's own shape; the PRD's recorded open question) — the check covers collisions across the spread records, which the manifest would otherwise merge silently.
- **Duplicate sources per entity** — fate resolves a view to one definition by type name, so a second source is a silent override waiting to happen.
- **View-reachable entities without a source** — every entity reachable through a view object (operation success views + nested relation views, recursively) must have a source: `view-reachable entity "Definition" has no source (reached from queries["term"])`. String-typed operations (`type: "Health"`) have no view by design and require nothing.

## Migration coexistence (raw legacy records)

Raw bridge-shaped entries spread into the same config and pass through to `createFateServer` untouched (task 7), contributing `never` to R:

```ts
queries: {...bridgeQueries, term: Fate.query(...)},           // legacy promise resolvers + new entries
sources: [...newSources, {definition: userSource, executor: userExecutor}], // legacy pair as one entry
```

The legacy operation shape is `RawFateOperation` (`{resolve, type?, input?, defaultSize?}` — `kind?: undefined` is the discriminant, so a `Fate.*` entry dropped into the wrong record is a compile error, not a miscategorized resolver). The legacy source shape is `RawFateSourceEntry` (`{definition, executor}` — the definition object is held by identity for fate's registry).

## What not to do

- **Don't `@ts-expect-error` an undischarged-layer pin.** The effect LSP plugin reports the mismatch as TS377034 (`missingLayerContext`), which escapes the directive under tsgo — same family as the TS377003 finding in [fate-effect-operations.md](./fate-effect-operations.md). Pin with `expectTypeOf(...).not.toExtend<Layer.Layer<FateServer>>()` bounds instead.
- **Don't export a config whose inferred type embeds a raw kernel `dataView()` value** (e.g. inside an inline legacy source) — fate's non-exported symbol key trips TS2883 under composite tsgo. Annotate legacy source entries with `RawFateSourceEntry` at the declaration site; `Fate.*` entries are already portable.
- **Don't provide `CurrentUser`/`LivePublisher` from worker-level layers** — they're per-request. If they show up at a `Layer.provide` site, the request boundary is in the wrong place.
- **Don't pre-merge feature records through a helper** — the config's spreads ARE the merge, exactly fate's shape; the layer's init check is the safety net for cross-record collisions.
