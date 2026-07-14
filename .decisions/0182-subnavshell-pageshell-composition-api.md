---
id: 0182
title: SubnavShell / PageShell composition API — flat element-props (one prop per zone), orphan-slot as a type error
status: accepted
date: 2026-07-14
tags: [design, frontend, navigation, composition, information-architecture]
---

# 0182 — SubnavShell / PageShell composition API — flat element-props

## Context

This is a **conversation-authored** decision, authored directly (not via report → triage)
and merged issueless on the doc lane per ADR [0075](0075-issueless-doc-pr-merge-seam.md). It
transcribes a founder ruling ([#2971](https://github.com/kamp-us/phoenix/issues/2971)) faithfully:
it is the law the ten children of epic [#2954](https://github.com/kamp-us/phoenix/issues/2954)
build against, so precision matters more than prose.

ADR [0176](0176-nav-ia-discipline.md) fixed the nav **information architecture** — the closed
element taxonomy (destination / primary action / utility / signal) and the placement law (which
class lives in which zone), with the per-product **Subnav** as the product zone. What 0176 did
*not* fix is the **composition API** of that Subnav: how a product surface hands its elements to
the bar. That gap is what let the shape drift.

A live audit of the five real subnav consumers grounded this decision:

- **mecmua** — sub-destination tabs (`akış` / `yazılarım`) + a promoted `yaz` CTA.
- **pano** — sort/filter chips + a site/host context crumb + a `N başlık` count + a `yeni` CTA.
- **divan** — reviewer sections, no promoted verb (its subnav has no CTA and that is correct).
- **sözlük** — an alphabet strip + a go-to-or-create box, no promoted verb.
- the **shared `Subnav` primitive** ([`apps/web/src/components/layout/Subnav.tsx`](../apps/web/src/components/layout/Subnav.tsx))
  every one of them wraps, whose slot list had sprawled to `title` / `count` / `filters` / `links`
  / `crumb` / `input` / `meta` / `cta`.

Two smells fell out of the audit. First, the primitive carried redundant slots — `title` is
chrome that maps to no 0176 zone, and `count` and `meta` are the same read-only `span` treatment
under two names. Second, and load-bearing: sözlük's alphabet rendered as a **detached sibling**
next to the bar rather than inside it — an orphaned slot with no structural home, the kind of
gap a compound-component API leaves undetectable except by lint.

## Decision

Faithful transcription of the founder ruling on #2971. This ADR **builds on** ADR
[0176](0176-nav-ia-discipline.md)'s element taxonomy — it does not amend or supersede it; 0176's
four-class taxonomy and placement law stand unchanged and are the ground this API stands on.

### Flat element-props — ONE prop per zone

`SubnavShell` takes **flat element-props: one `ReactNode` prop per zone.** NOT a zones-object,
NOT compound components (`<SubnavShell.Destinations>…`). The rationale is
make-invalid-states-unrepresentable: a compound-component API leaves an **orphan slot** — an
element rendered but placed nowhere — detectable only by a lint pass. Flat element-props make an
orphaned slot a **TYPE error** instead: an element that isn't assigned to a declared zone prop
simply has nowhere to go and won't compile in. The zones below are grounded in ADR 0176's real
element taxonomy — they are not invented here.

`SubnavShell` props (the law, exactly):

- **`leading?: ReactNode`** — context / crumb (e.g. pano's site/host crumb).
- **`destinations?: ReactNode`** — **ONE** slot; the route-links OR stateful buttons are composed
  *inside* it by the consumer (mecmua tabs / pano chips / divan sections / sözlük alphabet). The
  shell does not enumerate destinations — it hands the consumer one zone and the consumer fills it.
- **`primaryAction?: ReactNode`** — the ONE promoted verb (mecmua / pano). **ABSENT for divan and
  sözlük is normal, not a gap** — a subnav with no promoted verb is a valid subnav.
- **`signal?: ReactNode`** — meta / count (e.g. pano's `N başlık`).

### `utility` is deferred by YAGNI — sanctioned, deliberately not slotted

The `utility` zone is **OMITTED**. Its only real consumer today was sözlük's go-to-or-create box
(the primitive's current `input` slot), which the founder is folding into the global `⌘K` search
(a separate follow-up). `utility` is a **sanctioned ADR-0176 element class** — it is not being
denied legitimacy; it is **deliberately not slotted** into `SubnavShell` until a real consumer
needs it. Adding a `utility?` prop later is a **deliberate law change, NOT drift**: the next
author who wants it makes an explicit amendment, they do not quietly discover a gap and fill it.

### PageShell composes SubnavShell

**`PageShell`** composes `SubnavShell` as its top zone plus the routed page content below it. A
product page is a `PageShell` — the subnav-plus-content shape is named once, not rebuilt per
surface.

### Wrap the existing `Subnav` primitive — do NOT replace it

`SubnavShell` **wraps** the existing `Subnav` primitive
([`apps/web/src/components/layout/Subnav.tsx`](../apps/web/src/components/layout/Subnav.tsx)); it
does not reimplement or replace it. Wrapping is where the slot-sprawl is collapsed:

- **DROP `title`** — chrome that maps to no 0176 zone.
- **MERGE `count` → `signal`** — `count` and `meta` are the identical read-only `span` treatment
  today; they collapse into the single `signal` zone.

### The orphan smell dies structurally

sözlük's alphabet becomes **`destinations={<SozlukAlphabet/>}`** — rendered *inside* the bar, with
no detached sibling. This holds in **both** flag states (behind the existing `phoenix-nav-ia`
flag). The structural change is the fix: the orphan is not linted away, it is made unrepresentable
because there is no "next to the bar" slot to render into — only the `destinations` zone inside it.

## Consequences

- **Orphan-as-type-error.** An element not assigned to a declared zone prop cannot be rendered by
  the shell — the compound-component orphan-slot class (detectable only by lint) is closed at the
  type level. This is the make-invalid-states-unrepresentable payoff over a zones-object or
  compound API.
- **`utility` is deferred, not dropped.** It remains a legitimate ADR-0176 class; re-introducing a
  `utility?` prop is a sanctioned, explicit law change when a real consumer arrives — never a
  silent fill-in. This ADR is the record that its absence is deliberate.
- **`Subnav` is wrapped, not replaced.** The primitive keeps rendering; `SubnavShell` narrows its
  surface (drop `title`, merge `count` → `signal`). No consumer touches `Subnav`'s slots directly
  once migrated — they go through the shell's four zones.
- **Migration lands behind `phoenix-nav-ia`.** The ten children of #2954 migrate the five consumers
  onto `SubnavShell` / `PageShell` behind the existing `phoenix-nav-ia` flag; the sözlük-alphabet
  fix holds in both flag states.
- **Coupled vocabulary.** This ADR coins `recipe` and `shell` as architecture terms; their
  canonical one-line definitions land in [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) in the
  same PR (see Vocabulary impact below).
- This ADR **builds on** ADR [0176](0176-nav-ia-discipline.md)'s taxonomy and **does not amend or
  supersede** it. It adds a composition-API law where 0176 was silent; it relaxes no existing guard.

### Vocabulary impact

Two terms coined, both routed to [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) in this PR:

- **`recipe`** — the composition-primitive idiom (one flat element-prop per zone, orphan-as-type-error).
- **`shell`** — the layout-composition wrapper (`SubnavShell` / `PageShell`) that names a
  page's zone-plus-content shape once.

### References

- Founder ruling [#2971](https://github.com/kamp-us/phoenix/issues/2971) — the decision this ADR transcribes.
- Epic [#2954](https://github.com/kamp-us/phoenix/issues/2954) — the ten children this law unblocks.
- ADR [0176](0176-nav-ia-discipline.md) — the nav IA taxonomy + placement law this API builds on.
- ADR [0075](0075-issueless-doc-pr-merge-seam.md) — the issueless conversation-authored doc lane this PR ships on.
</content>
