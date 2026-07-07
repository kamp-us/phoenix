# fate-effect data views — the `FateDataView` class factory

> Derived from the in-repo source (`packages/fate-effect`, `apps/web`) + `@nkzw/fate@1.3.1` where the lib is implicated — re-verify on pin bump.

How `@kampus/fate-effect` (the workspace package at `packages/fate-effect`) declares fate data views. The short answer: **a view is an exported class whose static `view` IS the kernel `dataView()` output, unchanged** — the class exists to give the view a nameable exported type, which is what makes fate's own `Entity<>` derivation usable across module boundaries. This replaced the worker's `DataViewOf`/`EntityOf` helpers (deleted in the v1 cutover, ADR 0042); `ViewRow` survives in `worker/features/fate/view-types.ts` as the shared row restatement every view uses.

## Declaring a view

```ts
import {type Entity, FateDataView} from "@kampus/fate-effect";

export class DefinitionView extends FateDataView<DefinitionRow>()("Definition")({
	id: true,
	body: true,
	score: true,
	createdAt: true,
}) {}

export class TermView extends FateDataView<TermRow>()("Term")({
	id: true,
	slug: true,
	title: true,
	definitions: FateDataView.list(DefinitionView, {
		orderBy: [{score: "desc"}, {createdAt: "asc"}, {id: "asc"}],
	}),
}) {}

export type Definition = Entity<typeof DefinitionView>;
export type Term = Entity<typeof TermView, {definitions?: Array<Definition>}>;
```

- The inner calls are exactly fate's `dataView("Name")({fields})` curry; the leading `()` is the Effect dummy-call (`Schema.TaggedErrorClass<Self>()`'s reason: TypeScript has no partial type-argument inference, and the row type must be explicit while the name infers as a literal).
- The field map is fate's own config vocabulary — `true`, `computed`, `resolver`, `count` all pass through untouched. Only list relations use `FateDataView.list` (below).
- `View.view` is the kernel dataView (pass it anywhere fate wants one); `View.typeName` is the literal name. Instances of the class are meaningless.
- `Entity<typeof View>` is fate's `Entity<view, name>` with both arguments read off the class; the optional second parameter is fate's `Replacements`, unchanged. Two restatements ride in it (see `sozluk/views.ts`):
  - **list relations** (`definitions?: Array<Definition>`) — for the same reason they do under fate directly: kernel `list()` widens the child's field map in its return type;
  - **timestamp fields** (`createdAt: Date`, …) — fate's `Entity<>` types `Date` row fields as `string` (the JSON wire shape), but worker-side entity values carry live `Date` objects until fate serializes the response. The shapers and every worker call site are pre-serialization, so restate them — otherwise every shaper literal breaks.

## Why a class (the TS2883 story)

fate's `dataView()` return type is `DataView<Item> & {readonly [dataViewFieldsKey]: Fields}`, and neither `DataView` nor the symbol is exported from `@nkzw/fate/server`. In a composite tsgo project (the worker is one) an **exported** raw view const therefore trips the declaration-nameability checks — TS2883 ("inferred type cannot be named without a reference to … not portable") plus TS4023 for the symbol. The pre-package dodge annotated views with `SourceDefinition<Item>["view"]`, which is nameable but **erases the literal field map**, killing `Entity<>` and forcing the hand-rolled `EntityOf` restatement.

The class factory keeps both properties at once:

- a `class TermView extends …` declaration is its own nameable type — `typeof TermView` is the portable reference, so the inferred-type check never needs fate's private names;
- the factory's return is annotated with package-owned portable aliases (`KernelDataView<Item, Fields>` spells the kernel's symbol-keyed type using only names reachable from the package barrel), so the literal field map survives into `Entity<typeof View>` with full fidelity.

`packages/fate-effect/src/DataView.unit.test.ts` is the standing guard: its module-level exported views are checked by the package's composite tsconfig on every `pnpm typecheck`, and its type tests pin `Entity<typeof View>` ≡ fate's `Entity<typeof kernelView, "Name">` for equivalent declarations.

## `FateDataView.list`, not kernel `list()`, inside class fields

A raw kernel `list(view, options)` field **inside an exported class** reintroduces the problem through the field-map type argument: `list()`'s return type carries fate's private `dataViewBaseKey`/`dataViewListOptionsKey` symbols (TS2883 + TS4020 "extends clause … is using private name"). `FateDataView.list(View, options)` is the same kernel `list()` call at runtime — same object, internal symbols intact for `getBaseDataView`/`getDataViewListOptions` — returned through a portable annotation that erases the type-level-only symbols. Entity derivation is provably identical either way (the package's type tests compare against kernel twins built with raw `list()`).

## What not to do

- Don't export a raw `dataView(...)(...)` const — that is the TS2883 hazard the factory exists to remove. Unexported locals (test twins, intermediate views) are fine.
- Don't use kernel `list()` inside a `FateDataView` field map — use `FateDataView.list(SiblingView, options)`.
- Don't pass the class itself where fate wants a view at runtime — fate's walkers (`collectDataViewConfigs`, codegen) skip non-objects, and a class constructor is `typeof "function"`. The class carries the view; `View.view` is the view.
- Don't restate field selections to derive entity types (`EntityOf`-style) — `Entity<typeof View>` reads the one field map the view already declares.
