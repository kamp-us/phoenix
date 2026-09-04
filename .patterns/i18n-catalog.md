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
supplies it — see `commentBodyValidator` in `pages/PanoPostDetail.tsx`.

A catalog file may carry a **cluster** of sub-surfaces rather than one, each keeping its own key
prefix — `i18n/tr/account.ts` holds `profile.*`, `bildirim.*`, `mute.*`, `ui.*` and the rest of the
identity-facing copy. Split a file per component directory only when the directories move
independently; nine files nothing else distinguishes are nine merge targets, not nine surfaces.

## Copy that used to live in a module constant

A message table declared at module scope — a `WireMessageOverrides` map, a label lookup — is
evaluated once, when the module is first imported, so a `t` call inside it freezes whichever
locale was live then. Turn the constant into a function of `t` and build it per render:

```ts
function panoSubmitOverrides(t: Translate): WireMessageOverrides {
	return {TITLE_REQUIRED: t("pano.error.titleRequired"), …};
}
// in the component
const overrides = React.useMemo(() => panoSubmitOverrides(t), [t]);
```

The `useMemo` is a cheap guard, not a correctness requirement. `LocaleProvider` memoizes its
context value on `[locale, setLocale, catalog]`, so `t` is stable until the locale swaps and the
table is rebuilt only then. Nothing downstream reads the table's identity: `useDraftSubmit` and
`useDraft` declare no dependency array and read `options.overrides` inside their own closures at
call time. A helper that took the table at module scope takes it as a parameter instead —
`validatePostFields(t, overrides, …)`.

## Copy a pure helper decides

A helper outside a component picks the **key**, never the string: `bildirimCopy`,
`profileStandingLabelKey`, `shareFeedbackLabelKey`. It returns a `CatalogKey` (or takes a
`Translate` when it also has to interpolate), so the one catalog read stays at the render site and
the helper's unit test asserts against `tr[key]` instead of a literal. `plural` is generic in its
form type, so `t(plural(locale, n, {one: "…", other: "…"}))` type-checks with two keys.

## A DOM-free module returns a key, never copy

Much of the decision logic behind these surfaces lives in plain `.ts` modules beside the
component — `divanGating.ts`, `flag-overrides.ts`, `remove-the-wave.ts` — because `apps/web/src`
has no jsdom and those decisions are unit-tested. Such a module cannot call `useT`, so **it
returns a `CatalogKey` and the component translates it**:

```ts
export function itemKindLabel(kind: TargetKind): CatalogKey { … }
```

When the copy interpolates, the module returns the key plus its params. `divanGating.ts` exports
the shape the other divan modules import:

```ts
export type Message = {readonly key: CatalogKey; readonly params?: MessageParams};
```

Three consequences worth knowing before you write one:

- **A module that only composed two Turkish strings loses its reason to exist.** The composed
  form becomes one flat key, so the helper goes. Only reach back for composition when English
  needs an arm the Turkish does not — see the plural note below.
- **A caller-supplied noun stays a prop, not a literal.** `ActorIdentity` takes `fallbackLabel`
  as a string; divan passes `t("divan.caylak.fallback")`. The shared module still holds no copy.
- **The unit test then asserts the key**, not the Turkish. Where the test's point is that the
  copy reads a certain way, it resolves the key through `trCatalog` and asserts that.

Formatting a date or a number is the same rule seen from the other side: the module takes the
`Locale` and formats with it (`createdAtLabel(createdAt, locale)`), so no surface hardcodes
`tr-TR`.
## Plurals pick a message, not a key

`plural` is typed `PluralForms → string`, so feeding it two catalog *keys* returns a `string`
and `t` refuses it. Feed it two already-translated messages instead:

```ts
plural(locale, count, {
	one: t("pano.post.commentCount.one", {count}),
	other: t("pano.post.commentCount.other", {count}),
});
```

Both arms are looked up either way, which costs nothing and keeps the whole thing typed. Where
more than one component renders the same counted phrase, wrap it once
(`components/pano/commentCount.ts`) so the arm is picked in a single place.

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

That whole-word rule is what you trip over when Turkish suffixes the noun. `divanda` is not a
whole-word `divan`, so the key's `tr` count is 0 — and an English message that spells `in the divan`
counts 1 and reds the invariant. Two ways out. **Give the English side a placeholder and pass the
noun in**, out of an `auth.brand.*`-style key so it is still catalog copy rather than a literal:

```ts
// tr — the suffixed word, unchanged
"auth.landing.col.pano": "panoda son 24 saat",
// en
"auth.landing.col.pano": "the last 24 hours on {panoNoun}",
```

```tsx
t("auth.landing.col.pano", {panoNoun: t("auth.brand.pano")})
```

Name the placeholder `{panoNoun}`, **never `{pano}`**: the invariant scans with `\p{L}+`, braces are
not letters, so `{pano}` reads as the word `pano` and counts. A noun whose Turkish spelling mutates
under the suffix (`sözlük` → `sözlüğe`) can only be written out on the `tr` side; the placeholder
still belongs on the `en` one. Or, where the phrase reads fine without the noun, **write the English
around it** (`up for review`, `one of the yazars`) rather than reintroduce a noun the Turkish only
carries suffixed (`divandaki`, `yazarsın`, `çaylakların`).

## Plurals

**A sentence carrying N independent counts needs N clause messages plus a frame.** The wave
confirm counts targets and reports, and pluralizing the whole line on either one renders "1
target · closes 1 reports" in English. So `blastRadiusLabel` returns a frame message plus a
clause message, and the component interpolates the resolved clause into the frame. The roster
line and the actor drawer's üretim line do the same over four and three counts. Turkish is
unaffected either way, which is exactly why this is easy to miss.

The countable nouns the divan reuses across those lines live once, as
`divan.count.{items,definitions,posts,comments}.{one,other}`, and `countClause(kind, count)` in
`divanGating.ts` picks the arm. The frame then holds only the separators — `divan.actor.uretim`
is `"{definitions} · {posts} · {comments}"` in both locales, with every inflected word in a
clause.

**A count that is provably never 1 needs no arm of its own.** `reporterDiversityLabel` returns
early below two reports, so `count` is at least 2 on the diversity arm and only `distinct` moves
between the arms — one pair of keys, not a frame. Rely on this only where the code proves the
floor at the return site.

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
