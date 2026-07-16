# atölye — the exhibit harness

How atölye (the in-product museum of craft, epic
[#2473](https://github.com/kamp-us/phoenix/issues/2473)) renders a UI component live beside
typed **prop-knobs**. The harness core lives in `apps/web/src/lab/atolye/`; this doc is the
contract the index route ([#3092](https://github.com/kamp-us/phoenix/issues/3092)), the detail
route ([#3093](https://github.com/kamp-us/phoenix/issues/3093)), the primitive catalog
([#3094](https://github.com/kamp-us/phoenix/issues/3094)), and the composer fold-in
([#3095](https://github.com/kamp-us/phoenix/issues/3095)) all build against.

It is a **client-only** surface: no worker, no fate, no DO. Every control is a base-ui primitive
under the ADR-0162 role tokens (`design-system-manifest.md`) — atölye dogfoods the design law it
showcases. No external storybook tool (Storybook/Ladle) — founder-ruled out, hard.

## The three parts

### 1. The knob schema — soundness lives in the type layer (`knob.ts`)

A **knob** is one on-screen control bound to one host-component prop. Four kinds:
`string`→text · `number`→number · `boolean`→base-ui `Switch` · `enum`→base-ui `ToggleGroup`.

`KnobForType<T>` maps a prop's type to the one knob it admits, so **invalid states are
unrepresentable at compile time, not caught at runtime**: a `boolean` prop takes only a
`BooleanKnob`, an open `string` a text knob, a string/number literal-union an `EnumKnob` over that
exact union; a non-`KnobValue` prop (a `ReactNode`, a callback) maps to `never` — it cannot be a
knob and must be passed via `fixedProps`. `KnobSchema<P>` is the per-prop map: a knob key must be a
real prop of `P`. The soundness is asserted by the compile-time `Expect<Equal<…>>` checks and the
`@ts-expect-error` negative cases in `knob.test.ts` (verified by `pnpm typecheck`).

### 2. The exhibit contract — one declarative unit (`exhibit.ts`)

An **exhibit** is `{ id, title, summary?, component, knobs, fixedProps? }`. Author one with
`defineExhibit<P>(…)`, which captures the component's props `P` so the knob schema is type-checked
against real props at the declaration site, then widens to `AnyExhibit` (the props-erased shape the
registry stores) — the existential-type boundary that lets heterogeneous exhibits share one array.

`title`/`summary` are the **Turkish** curation copy (brand nouns stay Turkish, per
`.glossary/LANGUAGE.md`); `id` is the English kebab-case slug (the URL segment + registry key).

### 3. The registry — headless enumeration (`registry.ts`)

The registry is a plain typed array with two headless accessors: `listExhibits()` (curated order —
the array order **is** the curation order) and `getExhibit(id)` (`undefined` for an unknown slug —
the detail route's not-found). No UI, importable by a route or a test/agent.

## Adding an exhibit

1. Author `exhibits/<Name>.exhibit.tsx` exporting `defineExhibit<React.ComponentProps<typeof X>>({…})`
   — enum knobs for literal-union props, boolean knobs for flags, `fixedProps` for anything not
   knobbable (`children`).
2. Add one line to the `exhibits` array in `registry.ts` (its position sets its catalog order).

No route edits — the registry is the seam that keeps index/detail/catalog decoupled. See
`exhibits/Button.exhibit.tsx` for the worked exemplar.

## Rendering — `ExhibitStage` + `PropKnobs`

`ExhibitStage` mounts an exhibit's component beside its knobs and owns the knob state via
`useKnobs`; the knob-value → props seam is a single spread, `{...fixedProps, ...values}`.
`useKnobs` is kept separate from the panel so #3093 can lift knob state into the URL
(deep-linkable) without re-implementing the plumbing. `PropKnobs` is the presentational,
controlled panel — one labelled base-ui control per knob (every control carries an
`aria-labelledby`, pillar 4).

Enum knobs stringify their option values at the `ToggleGroup` boundary (base-ui `ToggleGroup` keys
on `string`) and map back to the real knob value on change, with single-select last-wins semantics.
