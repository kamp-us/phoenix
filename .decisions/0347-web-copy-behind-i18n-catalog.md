---
id: 0347
title: apps/web copy is Turkish and English behind a typed catalog, never Turkish only
status: accepted
date: 2026-09-03
tags: [i18n, language, apps-web, glossary]
---

# 0347 — apps/web copy is Turkish and English behind a typed catalog, never Turkish only

**What this decides:** kamp.us reads in Turkish or English, the reader picks, and every string
comes from one typed message catalog per locale — but the brand nouns and every technical name
stay exactly as they are.

## Context

`CLAUDE.md` and [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) §3 both said user-facing copy
stays Turkish. That was never recorded as a decision, so there was nothing to read the reasoning
off — and `apps/web` grew ~900 lines of inline Turkish JSX plus two wire-code string maps
(`fate/wireMessages.ts`, `pages/usernameMessages.ts`) with no place an English string could live.

The founder overturned that rule on 2026-09-02, recorded at
[kamp-us/phoenix#7519 (comment 5519951232)](https://github.com/kamp-us/phoenix/issues/7519#issuecomment-5519951232)
and mirrored onto this ADR's issue at
[#7526 (comment 5522562483)](https://github.com/kamp-us/phoenix/issues/7526#issuecomment-5522562483):

> **yes, pitch approved.** … "i am changing that standing of user facing copy stays turkish.
> turkish & english behind an i18n pipeline makes the most sense to me."

A ruling in one comment is a ruling the next session re-decides differently, and the two docs said
the opposite of it, so this ADR records it and the same pull request narrows both.

The foundation half is the other thing a comment cannot carry. Epic #7519's plan picked a
hand-rolled catalog, and [`reports/2026-09-02-i18n-options.md`](../reports/2026-09-02-i18n-options.md)
checked that pick against Paraglide, Lingui, i18next, react-intl and typesafe-i18n at their
2026-09-02 versions. Two locales, `one`/`other` plurals in both (`Intl.PluralRules` on the pinned
Node reports exactly those categories for `tr` and `en`), ~1000 strings, and a repo that already
uses an exhaustive `Record` as its type-safety mechanism. Every library either brings a message
parser this size does not need or a codegen/plugin surface that fights Biome's GritQL plugins and
the `catalog:` rule.

## Decision

**`apps/web` user-facing copy is Turkish and English, both served from one typed message catalog
per locale, with Turkish the default; brand nouns are never translated and everything technical
stays English.**

**The language rule.**

- `apps/web` user-facing copy renders in the reader's locale, `tr` or `en`. Turkish is the default:
  a reader who chooses nothing gets Turkish, and dropping Turkish is not on the table.
- Product and brand nouns are **never** translated in either locale. `sözlük`, `pano`, `mecmua`,
  `kampus`, `divan`, `yazar`, `çaylak`, `kefil`, `bildir`, `künye`, `depo`, `sustur`, `engelle` —
  the whole `.glossary/LANGUAGE.md` §3 table — read identically in the English interface. The brand
  reads the same to both readers.
- Everything technical stays English: URL routes and paths, code identifiers, D1 table and column
  names, file names. The canonical example holds unchanged — the route is `/search?q=`, not `/ara`.
- **Tuval, Fabrika and Demlik are English-only.** Only the product name is Turkish; all their
  vocabulary, copy, identifiers and docs are English, and none of them coins a Turkish name. Tuval
  is its own app under `apps/` per ADR [0345](0345-tuval-lives-under-apps.md); `apps/web` is the
  one product with Turkish user-facing copy, and this rule keeps it the only one.

**The foundation.**

- A hand-rolled typed catalog under `apps/web/src/i18n/`: a `Record<Key, string>` per locale, so a
  key present in `tr` and missing in `en` is a `pnpm typecheck` failure rather than a runtime
  fallback nobody notices.
- **No runtime i18n dependency.** No framework, no extractor, no codegen step, no translation
  service.
- Per-surface catalog files (`i18n/tr/auth.ts`, `i18n/en/auth.ts`, …) merged in an index, so the
  catalog is not a single shared write target and two surface migrations do not collide.

**Binding constraints.**

- No route, identifier, D1 table/column or file name is renamed to carry a locale.
- No brand noun is translated, transliterated or given an English alias in the `en` catalog.
- No runtime i18n library enters the workspace catalog for `apps/web` under this decision. A third
  locale, or an ICU `select`/gender need, is the point to re-open it — and
  `reports/2026-09-02-i18n-options.md` names Paraglide as the fallback, whose `m.key({params})`
  call shape makes that migration mechanical.
- No Turkish name is coined in Tuval, Fabrika or Demlik.

## Consequences

A Turkish reader sees no change: `tr` is the default and the copy is the copy it always was. An
English reader gets a real interface instead of a wall of Turkish, without the brand nouns
dissolving into translations that would make it a different product.

Cost: every user-facing string in `apps/web` has to move out of JSX and into the catalog before the
English locale is worth switching on, which is why epic #7519 splits that migration one child per
surface. Until the last one lands, a hardcoded string is a silent Turkish-only hole — a fail-closed
CI guard closes the epic for that reason.

The catalog gives compile-time key parity and nothing else. A string that is never keyed at all is
invisible to the type checker, so the guard is the mechanism that catches it, not the types.

The docs this replaces are narrowed in the same pull request: `CLAUDE.md`'s "Turkish for
product/brand, English for technical" convention bullet and `.glossary/LANGUAGE.md` §3. Both now
point here rather than restating the rule.

A third doc still states the opposite and is **not** narrowed here.
[`.patterns/error-copy-law.md`](../.patterns/error-copy-law.md)'s "Out of scope: i18n / translation"
section says kamp.us copy is authored in English as the source language and shipped in Turkish
through a translation layer, and routes the reader on to issue #3378, which is closed. This decision
has no source language and no translation layer — `tr` and `en` are authored peers — so that section
now reads stale in the inverse direction. `.patterns/` is a different doc surface than this change's
three files, so the correction is filed as
[#7635](https://github.com/kamp-us/phoenix/issues/7635), folded by triage into open epic
[#7519](https://github.com/kamp-us/phoenix/issues/7519), which owns the `apps/web` i18n surface and
carries the fix. Until that lands, this record is the one to read, not that section.

## Records

Vocabulary impact: three technical terms are coined and land as rows in
[`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) §3 in this pull request — **locale** (`tr` |
`en`, the reader's chosen language), **catalog** (the typed per-locale message record under
`apps/web/src/i18n/`), and **catalog key** (the identifier a surface passes to read one message).
They belong beside the language rule they serve rather than in `.glossary/TERMS.md`, which holds
domain nouns. No product or brand noun changes.
