# @kampus/fate-effect

Use `@kampus/fate-effect` to author fate queries, lists, mutations, sources, and views with Effect.
This page is the task guide. Read [reference.md](./reference.md) for lookup material,
[walkthrough.md](./walkthrough.md) for a start-to-finish lesson, and
[ADR 0042](../../.decisions/0042-fate-effect-v1-architecture.md) plus
[ADR 0043](../../.decisions/0043-fate-effect-v2-native-interpreter-cutover.md) for the design and
history.

The package owns the server and authoring substrate. The host owns HTTP routing, abort wiring, and
database services; client code consumes the generated fate API.

## Author entries

Define errors with `FateWireCode`, views with `FateDataView`, sources with `Fate.source`, and
operations with `Fate.query`, `Fate.list`, or `Fate.mutation`. Use the focused recipes for each task:

- [data views](../../.patterns/fate-effect-data-views.md)
- [sources](../../.patterns/fate-effect-sources.md)
- [operations](../../.patterns/fate-effect-operations.md)
- [wire errors](../../.patterns/fate-effect-wire-errors.md)

For a guided build of one feature, use [walkthrough.md](./walkthrough.md).

## Guard view field maps against symbol slips

Apply the type-only `AssertFieldMapResolved` guard where all shipping views are assembled. The
second generic must extend the first; a slipped field-map symbol therefore produces a named compile
error at this definition site.

```ts
import type {AssertFieldMapResolved} from "@kampus/fate-effect";

type AssertResolved<Resolved, Guarded extends Resolved> = Guarded;
type NoteViewFieldMapResolved = AssertResolved<
	typeof NoteView,
	AssertFieldMapResolved<typeof NoteView>
>;
```

The shipping example is the worker's
[view assembly](../../apps/web/worker/features/fate/views.ts). The guard is a type alias, not a
runtime function.

## Compose one config and layer

Build the one config shared by serving and code generation, then discharge domain services in its
layer:

```ts
import {FateServer} from "@kampus/fate-effect";
import * as Layer from "effect/Layer";

export const fateConfig = FateServer.config({
	queries: panoQueries,
	lists: panoLists,
	mutations: panoMutations,
	sources: panoSources,
});

export const FateLive = FateServer.layer(fateConfig).pipe(Layer.provide(Pano));
```

Use the [server pattern](../../.patterns/fate-effect-server.md) when adding sources or request
services.

## Serve a request

Call the interpreter on the host's request fiber and provide fresh request values:

```ts
import {FateInterpreter, type FateRequestContext} from "@kampus/fate-effect";

const context: FateRequestContext = {
	currentUser: {user: session?.user},
	livePublisher,
};
const response = yield* FateInterpreter.handleRequest(request, context);
```

Wire abort to interruption in the host. The worker
[route](../../apps/web/worker/features/fate/route.ts) is the shipping example.

## Generate client types

Export an inert server from the same config so the fate Vite plugin can import it at build time:

```ts
import {FateExecutor} from "@kampus/fate-effect";
import {fateConfig} from "./config.ts";

export const fateServer = FateExecutor.toCodegenServer(fateConfig);
```

Use `InferFateAPI<typeof fateServer>` for the client API type. See the
[compiler/codegen pattern](../../.patterns/fate-effect-compiler.md) for the complete setup.

## Publish live changes

Use `LivePublisher` for row or connection updates. Choose `invalidate` when a field is
viewer-derived; each subscriber must re-read its own value rather than receive the mutator's value.
The complete method table is in [reference.md](./reference.md#live-publish-surface), and
[ADR 0314](../../.decisions/0314-entity-invalidate-frame-upstream.md) governs entity invalidation.

## Check a change

```bash
pnpm --filter @kampus/fate-effect test
pnpm --filter @kampus/fate-effect typecheck
```

The suite checks the differential oracle, codegen types, protocol drift, wire-code enumeration, and
Effect-to-Promise conversion boundaries.

## Related task guides

- [interpreter](../../.patterns/fate-effect-interpreter.md)
- [worker wiring](../../.patterns/fate-effect-worker-wiring.md)
- [per-feature assembly](../../.patterns/per-feature-fate-aggregators.md)
