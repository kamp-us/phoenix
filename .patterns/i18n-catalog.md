# The i18n catalog — how `apps/web` copy is shaped

`apps/web` renders its copy in `tr` or `en` out of one typed catalog per locale, with `tr` the
default and no runtime i18n dependency. The *why* — including why no library was adopted — is ADR
[0347](../.decisions/0347-web-copy-behind-i18n-catalog.md), evidenced by
[`reports/2026-09-02-i18n-options.md`](../reports/2026-09-02-i18n-options.md). This page is the
shape: what the files are, and what to do when you migrate a surface.

## The layout

```
apps/web/src/i18n/
├── tr/
│   ├── layout.ts        one file per surface — the key set lives here
│   └── index.ts         merges every tr surface file into one flat record
├── en/
│   ├── layout.ts        the same keys, checked against tr/layout.ts
│   └── index.ts         merges every en surface file; reached ONLY dynamically
├── keys.ts              `CatalogKey` = keyof typeof tr
├── catalog.ts           tr static, en behind `import("./en")`; React-free
├── interpolate.ts       `{name}` substitution — the whole message format
├── plural.ts            `plural(locale, n, {one, other})` on `Intl.PluralRules`
├── locale.ts            the `Locale` type, the default, the endonym labels
├── brandNouns.ts        the nouns that never translate
└── LocaleProvider.tsx   the React face: `LocaleProvider`, `useLocale`, `useT`, `useTPlural`
```

`apps/web/src/lib/localeStorage.ts` persists the choice under `kampus.locale`, mirroring
`lib/themeStorage.ts` one for one.

## Adding a surface

1. Write `i18n/tr/<surface>.ts` exporting `const <surface>` plus
   `export type <Surface>Key = keyof typeof <surface>`.
2. Write `i18n/en/<surface>.ts` with the same keys, closing with
   `satisfies Record<<Surface>Key, string>`.
3. Spread both into their locale's `index.ts`.
4. In the component, `const t = useT()` and read `t("<surface>.<thing>")`.

**Keys are technical, so they are English** and dotted, prefixed by their surface —
`layout.userMenu.logout`. The key never changes when the copy does.

## When the key set comes from a vocabulary, not from the copy

`i18n/tr/wire.ts` is the exception to step 1: its keys are `` `wire.${FateWireCode}` ``, a template
literal over the wire-error vocabulary, so the key set is *derived* rather than authored. Both
locales then declare their record under a `Record<WireCodeKey, string>` **annotation** instead of
`satisfies`, which is what makes a code with no message and a message naming no code each a compile
error — in `tr` too, where `satisfies` would have made `tr` its own source of truth and let a code
go unmessaged. That coverage guarantee used to live in `fate/wireMessages.ts`'s
`Record<FateWireCode, string>` (#1422); it moved here with the copy.

The consumer takes the bound `Translate`, never a `Locale`: `en` is reachable only through
`catalog.ts`'s dynamic import, so a module outside a `LocaleProvider` subtree cannot resolve
English synchronously. A module-level rule that needs copy is curried on `t` and the component
supplies it — see `validateCommentBody` in `pages/PanoPostDetail.tsx`.

## The two type checks, and why they are in different files

`tr` is the source of truth for the key set. A key missing from `en` is caught by the index's
`satisfies Record<CatalogKey, string>`. A key **only** `en` declares is caught in the per-surface
file, not the index: TypeScript runs excess-property checks on a plain object literal and skips
spread members, so the index alone would let a stray English key through. Both directions are
`pnpm typecheck` failures.

`satisfies`, never `as`. The Biome `no-type-assertions` GritQL plugin bans the laundering casts,
and `satisfies` is erasable syntax, so it passes `erasableSyntaxOnly`.

## The Turkish path ships no English bytes

`catalog.ts` is the one module that reaches `en`, and it does so through `import("./en")`. That is
what keeps English out of the main chunk, so a Turkish reader downloads exactly what they
downloaded before the catalog existed. `catalog-split.unit.test.ts` holds it two ways: it bundles
`catalog.ts` with rolldown and asserts the entry chunk carries no English string, and it scans
`src/` for a static `from ".../en"` in shipped code. Adding one anywhere reds the second half even
when `catalog.ts` itself still splits.

`catalog.ts` therefore imports no React. The split test bundles that module, and a React edge
would make it bundle the renderer.

## `useT` does not throw outside a provider

Unlike `useTheme`, reading the locale context with no `LocaleProvider` above it returns the `tr`
catalog rather than throwing. Layout primitives render standalone — in `*.test.tsx`, in the atölye
exhibits — and `tr` is the default locale, so the context default hands them the same copy the
provider would. This is why migrating a component to `useT` leaves its existing tests green
unchanged.

## Brand nouns

`brandNouns.ts` is the list, and `brandNouns.unit.test.ts` grades every key: a noun appears the same
number of times in `en` as in `tr`, matched **whole-word**. Turkish is agglutinative, so
`bildirimler` contains `bildir` and a substring match would call every suffixed word a brand noun.

## Plurals

`plural(locale, n, {one, other})` and nothing more. `Intl.PluralRules` reports exactly `one` and
`other` for both `tr` and `en`, and `plural.unit.test.ts` asserts that against the running engine —
if a runtime ever reports a third category, that test is what says so. A third locale, or an ICU
`select`/gender need, is the point ADR 0347 names for re-opening the library question.

A **counted noun** — a number followed by a word that inflects — is two keys, `<thing>.one` and
`<thing>.other`, read through `useTPlural()`:

```tsx
const tp = useTPlural();
tp(term.count, {one: "sozluk.entryCount.one", other: "sozluk.entryCount.other"});
```

The hook picks the arm off the live locale and passes `count` in as a placeholder, so each message
carries its own `{count}`. Turkish takes no plural agreement after a numeral, so its two arms are
usually identical text — write both anyway, because the key set is shared and `en` needs the split.
`plural` is generic in its arm for exactly this: it picks between two catalog KEYS here and two
rendered strings elsewhere, and a key-picking `as` cast would trip Biome's `no-type-assertions`.

## One file per surface, and what counts as a surface

A surface is a set of screens that ship and change together, not one component. `tr/sozluk.ts`
carries `components/sozluk/*` plus the sözlük pages **and** `SearchPage`, under a `search.` prefix:
search renders sözlük's own term rows and shares its counted nouns, so splitting them would put one
surface's keys in two files. Prefixes stay per-screen inside the file.

## The flag

The reader-facing choice is dark behind `PHOENIX_LOCALE` (`phoenix-locale`): the `dil` row in the
UserMenu only renders with the flag on. The catalog underneath is not gated — `tr` strings come out
of it either way, so the flag gates the choice, not the pipeline.
