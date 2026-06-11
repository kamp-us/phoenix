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

- `config` mirrors `createFateServer`'s options shape. `queries`/`lists`/`mutations` are fate's records (dotted wire names → entries); `sources` is an **array** of `Fate.source` entries (the package's one deviation: fate's own `sources` option is the derived `{getSource, registry}` resolver, which only the oracle-baseline compile step builds — [fate-effect-compiler.md](./fate-effect-compiler.md) — keying the registry by the definition objects' identity; the serving interpreter reads the entry array directly). `live` passes through to fate unchanged.
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

but **no worker-level layer ever provides them**: the interpreter ([fate-effect-interpreter.md](./fate-effect-interpreter.md)) provides the pair onto each operation as VALUES off the one `FateRequestContext` the route builds (`currentUser` from the session, `livePublisher` from the request's execution context — the oracle-baseline compile step does the same on its plane), and `FateServerRequirements` excludes both from the layer's R. This is what made the bridge's `FateContext` smuggling unnecessary (the bridge is deleted — ADR 0042). `LivePublisher`'s publish methods are typed `Effect<void>` — waitUntil scheduling and error-swallowing live inside its layer, once, so "a publish cannot fail the mutation" is a type, not a per-call-site convention.

### The `LivePublisher` live implementation (worker-side)

The package owns only the tag + contract; the live implementation is the worker's — it needs the LiveDO topic fan-out and the request's execution context, which the package can't know. [`livePublisherFor(options)`](../apps/web/worker/features/fate-live/live-publisher.ts) builds the per-request service VALUE (a value, not a `Layer`) over two capabilities:

```ts
livePublisherFor({
	publish: (topicKey, message) => liveTopics.publish(topicKey, message, limits), // worker-init LiveTopics
	waitUntil: (promise) => executionCtx.waitUntil(promise),                       // the request's execution context
});
```

- **Wire shape by construction**: every publish resolves topics + frames through `makeLiveEventBus` ([`event-bus.ts`](../apps/web/worker/features/fate-live/event-bus.ts)) — the single frame-building code path, shared with the static `liveBusConfig` fate holds — so the `PublishMessage` shape cannot drift between surfaces. (`PublishMessage.match.procedure` is a plain `string`: the envelope is wire data; the publish side is string-typed — the package cannot know phoenix's procedures — and the typo gate is the schema-closed subscribe side plus the live integration suite.)
- **Scheduling**: the topic call is handed to `waitUntil` as a detached promise — nothing on the request path awaits the fan-out. The `Effect.runPromise` at that sink is a deliberate boundary: `waitUntil` is a Promise sink outside the request fiber, and on CF it is the *only* way to extend work past the response (no shutdown hook, no surviving daemon fibers — ADR 0029/0041), so a forked fiber would be killed with the request.
- **Swallowing, both halves**: a rejecting topic call is caught on the detached promise and logged; a synchronous throw is caught by `Effect.try` + `Effect.ignore({log: "Warn"})` — ADR 0039's swallow law applied once inside the implementation, which is what lets call sites carry no error handling at all.

## Init-time validation (dies at layer construction, names attached)

`FateServer.layer` dies with a `FateServerConfigError` (a defect — composition mistakes are programmer errors; E stays `never`) listing every problem at once:

- **Duplicate wire names across the category records** — `duplicate wire name "term" — declared by queries["term"] and lists["term"]`. Within ONE record, spread collapses duplicate keys before any code can see them (fate's own shape; the PRD's recorded open question) — the check covers collisions across the spread records, which the manifest would otherwise merge silently.
- **Duplicate sources per entity** — fate resolves a view to one definition by type name, so a second source is a silent override waiting to happen.
- **View-reachable entities without a source** — every entity reachable through a view object (operation success views + nested relation views, recursively) must have a source: `view-reachable entity "Definition" has no source (reached from queries["term"])`. String-typed operations (`type: "Health"`) have no view by design and require nothing.
- **Typeless mutations** — `mutation "definition.add" carries no wire type`: fate's manifest carries every mutation's wire type. `Fate.mutation` makes this unrepresentable in typed code (`MutationDefinition` requires `type:`); the runtime check guards the erased shape's wider `string | undefined`. It lives in `collectConfigIssues` so the same mistake fails layer construction AND both compile surfaces (`toCodegenServer` at build time; the oracle baseline's `toFetchHandler` on first call) with the same wording — pinned in all three suites.

## Entries are constructor-built only

Every config entry is a constructor value: the record types are `Record<string, AnyFateQuery>` / `AnyFateList` / `AnyFateMutation`, and `sources` is `FateSourcesList = ReadonlyArray<AnyFateSourceEntry>`. The raw bridge-shaped arms (`RawFateOperation` / `RawFateSourceEntry`) that carried migration coexistence were **removed with the v2 cutover** (ADR 0042's removal slate, landed with ADR 0043) — they no longer exist in the package, and no raw record exists in phoenix.

The one structural escape hatch that remains is a hand-built `AnyFateSourceEntry` with empty `handlers: {}` — for a **synthetic** view-reachable entity that has no by-id fetch path (`Contribution`). It satisfies the source-completeness validation while adapting to a capability-less executor; see the escape-hatch section of [fate-effect-sources.md](./fate-effect-sources.md).

## What not to do

- **Don't `@ts-expect-error` an undischarged-layer pin.** The effect LSP plugin reports the mismatch as TS377034 (`missingLayerContext`), which escapes the directive under tsgo — same family as the TS377003 finding in [fate-effect-operations.md](./fate-effect-operations.md). Pin with `expectTypeOf(...).not.toExtend<Layer.Layer<FateServer>>()` bounds instead.
- **Don't export a config whose inferred type embeds a raw kernel `dataView()` value** (e.g. inside an inline hand-built source entry) — fate's non-exported symbol key trips TS2883 under composite tsgo. Annotate hand-built entries with `AnyFateSourceEntry` at the declaration site (as `contributionSource` does); `Fate.*` entries are already portable.
- **Don't provide `CurrentUser`/`LivePublisher` from worker-level layers** — they're per-request. If they show up at a `Layer.provide` site, the request boundary is in the wrong place.
- **Never re-tag `CurrentUser` or `LivePublisher`.** The tag identifiers (`fate-effect/CurrentUser`, `fate-effect/LivePublisher`) are load-bearing: `FateServerRequirements` excludes the pair from R *by tag identity*, so a second tag with the same shape silently re-adds the requirement. Extend the service interface in place instead.
- **Don't pre-merge feature records through a helper** — the config's spreads ARE the merge, exactly fate's shape; the layer's init check is the safety net for cross-record collisions.
