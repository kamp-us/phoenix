---
id: 0414
title: Only five product names stay Turkish in English copy, never every brand word
status: accepted
date: 2026-09-27
tags: [i18n, language, apps-web, glossary]
---

# 0414 — Only five product names stay Turkish in English copy, never every brand word

**What this decides:** the English interface keeps sözlük, pano, kampus, mecmua and depo in
Turkish, calls divan "Council" and künye "Standing", and translates every other Turkish word
normally.

## Context

ADR [0347](0347-web-copy-behind-i18n-catalog.md) put `apps/web` copy behind a Turkish and English
catalog. Its language rule said brand nouns are never translated and listed 13 of them: the whole
`.glossary/LANGUAGE.md` §3 table plus yazar, çaylak and kefil. The code followed that list
exactly (`apps/web/src/i18n/brandNouns.ts`), so the English catalog kept verbs like `sustur` and
`engelle` and roles like `yazar` and `çaylak` in Turkish.

The founder ruled on 2026-09-26 that the list was wrong: only product names stay Turkish. The
ruling was given in session and is quoted verbatim in the amendments to
[kamp-us/phoenix#9862](https://github.com/kamp-us/phoenix/issues/9862):

> how the fuck did we actually decide these brand nouns, engelle is a not even a noun lol. it's a
> verb and it needs to be translated. only "product" names should stay -> sozluk, pano, kampus,
> mecmua. yazar and caylak are ok to be translated lol.

> depo can stay since it's a service/product like thing. divan is just a product feature, we can
> find a good translation for that in our own context. kunye is also the same with divan.

> council works

> yes, go with standing

The first quote names divan as a word to translate; the second keeps depo and asks for kamp.us
names for divan and künye; the last two pick those names. This ADR amends ADR 0347 in part: its
language rule's noun list is replaced, and the rest of 0347 stands.

## Decision

**In the English interface only five product names stay Turkish — sözlük, pano, kampus, mecmua
and depo — divan reads "Council", künye reads "Standing", and every other Turkish word is
translated.**

- The five product names read identically in both locales. `BRAND_NOUNS` in
  `apps/web/src/i18n/brandNouns.ts` holds exactly these five, and the per-key count test keeps
  them equal across `tr` and `en`.
- **divan** is "Council" and **künye** is "Standing" in English copy, capitalised as feature
  names. The capital also keeps künye apart from the plain word "standing" the catalog uses
  elsewhere ("you stake your own standing").
- **yazar, çaylak, kefil, bildir, sustur, engelle** are translated normally, using the English
  word the catalog already uses beside them: author, newcomer, vouch, report, mute, block.
- The `tr` catalog is unchanged, and so is everything technical: the `/divan` route, catalog keys
  (`divan.*`, `profile.standing.*`), file names, services and D1 names stay as they are under
  ADR 0347.

**Binding constraints.**

- No `en` message contains divan, künye, yazar, çaylak, kefil, bildir, sustur or engelle, whole
  or suffixed; a unit test in `apps/web/src/i18n/` enforces it.
- No word joins the five-name list without a new ruling. A new product name is the only kind of
  word that can.

## Consequences

An English reader sees "block", "mute", "author" and "newcomer" instead of Turkish verbs and roles,
and the product names still read the same in both languages. The English locale is not switched on
yet (#7537), so no reader has seen the old copy.

The suffix problem in the brand-noun count test (#7665) now only covers the five product names.

`.glossary/LANGUAGE.md` §3 is narrowed in the same pull request and keeps its table of Turkish
nouns: the table still names the Turkish product concepts, but only five of its rows are words
the English interface keeps.

## Records

No vocabulary impact: "Council" and "Standing" are English copy for divan and künye, recorded
in `.glossary/LANGUAGE.md` §3; no term is coined or redefined.
