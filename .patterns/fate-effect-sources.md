# fate-effect sources — `Fate.source`, the per-entity loader

How `@phoenix/fate-effect` declares a source. The short answer: **`Fate.source(ViewClass, {id}, handlers)` builds the loader for one entity** — the kernel `SourceDefinition` plus Effect handlers, with the loader contract (at least one of `byId`/`byIds`, silent reads, `E = never`) enforced at the type level. This is the package's replacement for the bridge's `fateSource` + hand-written `SourceDefinition` literals ([fate-sources.md](./fate-sources.md), [fate-effect-bridge.md](./fate-effect-bridge.md)), which keep governing legacy records until the migration rewrites them.

## Declaring a source

```ts
import {Fate} from "@phoenix/fate-effect";
import {Sozluk} from "./Sozluk.ts";
import {TermView} from "./views.ts";

export const termSource = Fate.source(TermView, {id: "slug"}, {
	byId: function* (slug) {
		const sozluk = yield* Sozluk;
		const rows = yield* sozluk.getTermSummariesByIds([slug]);
		return rows[0] ?? null;
	},
	byIds: function* (slugs) {
		const sozluk = yield* Sozluk;
		return yield* sozluk.getTermSummariesByIds(slugs);
	},
});
```

- The first argument is the **`FateDataView` class** ([fate-effect-data-views.md](./fate-effect-data-views.md)); the constructor reads `View.view` off it. Handler parameter types and the row type are inferred from the class — no annotations needed.
- `{id}` names the row's primary-key field — the field fate refs the entity by (`"slug"` for Term, `"id"` for most entities).
- The result carries `definition` (a kernel `SourceDefinition`, `{id, view}` — the exact object fate's identity-keyed registry will hold, created once), `typeName` (the literal entity name), and `handlers` (Effect-returning functions). The compile step (task 7) adapts `handlers` to fate's promise-shaped `SourceExecutor` through the worker runtime; `FateServer.layer` (task 5) unions `FateSourceServices<typeof src>` into its requirements.

## The loader contract (loader/resolver split)

Sources LOAD, operations RESOLVE. The constructor's types encode the whole contract:

- **At least one of `byId`/`byIds` is required** — a source that can't load an entity by ref is unrepresentable; `connection` alone doesn't typecheck. `byIds` is the workhorse (it's what kills N+1 under the v2 `RequestResolver` batching); implement it for every entity reachable as a relation.
- **Reads are silent.** `byId` returns `null` for a missing id; `byIds` returns the rows that exist — fewer than asked is success, not failure. Handlers return **raw domain rows**; fate masks them to the requested selection afterward.
- **`E` is pinned `never`.** A handler whose effect has a typed failure is a compile error. Infrastructure failures are defects (`Effect.die` / a dying service call), exactly like every other unrecoverable fault — they reject the operation without becoming domain values.
- **`R` is inferred** from the handler bodies (a domain service, `Auth`-style per-request services, …) and is visible on the source's type — a forgotten layer is a compile error at the composition site, not a runtime miss.

## Spans come from the constructor

Each provided handler body is passed to `Effect.fn("<Entity>.<capability>")` — `Term.byId`, `Term.byIds`, `Term.connection` — so the span name is derived from the view class and cannot drift. Consequences for authors:

- Write handler bodies as **plain generator functions** (or Effect-returning functions — the two halves of `Effect.fn`'s own body contract). Don't pre-wrap a handler in your own `Effect.fn`: you'd get a second, nested span.
- This is the source-side exception to the "handlers are `Effect.fn("<wire name>")`" rule for operations: operations have a wire name the author owns; a source capability's name is fully determined by entity + capability, so the constructor owns it.

## What not to do

- Don't pass `View.view` (or a raw kernel view) as the first argument — the constructor wants the class (`{view, typeName}`); the literal `typeName` is what names spans and feeds init-time source-completeness checks.
- Don't fail a loader with a typed error to signal "not found" — absence is `null`/fewer rows. Typed errors belong to operations ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)).
- Don't hand-write `SourceDefinition` literals next to `Fate.source` — `src.definition` IS the definition; creating a second `{id, view}` object breaks fate's identity-keyed registry assumptions.
- Don't reach for `connection` to make a source loadable — it paginates an already-loadable entity (keyset semantics, ADR 0019); refs resolve through `byId`/`byIds`.

`packages/fate-effect/src/Source.unit.test.ts` is the standing guard: exported source consts keep the declaration-nameability gate (TS2883) honest under the package's composite tsconfig, `@ts-expect-error` pins the at-least-one contract, and the span test pins the `<Entity>.<capability>` names.
