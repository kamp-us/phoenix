---
id: 0375
title: A program row's feature flag is read off its own config layer's features block, not the merged record
status: accepted
date: 2026-09-09
tags: [tuval, config, feature-flags, programs]
---

# 0375 — A program row's feature flag is read off its own config layer's `features` block, not the merged record

**What this decides:** a flag that gates whether a **program row** is registered is read out of the
`features` block of the config module that would build the row — the same file, one const above the
`programs` list. Every other flag reader keeps taking the merged record off the `Features` kernel
service (ADR 0363). The consequence a flag's author has to know: a row's flag is stated by the layer
that owns the row, so a global `~/.tuval/tuval.config.ts` naming it moves everything except the row.

**Relationship to ADR [0363](0363-tuval-feature-flags-in-config-file.md) — this ADR amends it in
part; it does not overturn it.** 0363's merge rule holds for every flag but the one class this
record names: a flag gating whether a program row is registered is read before the merge exists, so
a lower layer stating it does not move the row. That is a case 0363 did not have to answer, because
until #8734 no flag gated a row. 0363 carries the reciprocal `amended-in-part by [0375]` status-line
pointer; its body is untouched.

## Context

0363 rules a flag is "a key in the `features` block of `.tuval/tuval.config.ts`, merged across the
config layers at boot", and that "changing a flag means editing that file and restarting the desk".
The merge happens in `loadLayeredConfig` (`apps/tuval/src/config.ts`), which builds
`{...featuresDefault, ...global.features, ...project.features}` and hands the result to `start` as
the `Features` service (`apps/tuval/src/feature-flags.ts`).

A **row** cannot wait for that. `boot.ts` says so where `Features` is declared in the `Kernel` union:
"the row is built while a config module is being evaluated, which is before the merge exists
(#8595)". `loadConfigModule` imports the module and decodes its default export; the `programs` array
is already built by then. A row's layer can declare `Features` as a leftover requirement and be
handed it at spawn — that is the seam a Pi row already uses — but the decision "is this row in the
list at all" is taken one phase earlier, when there is nothing to read but the module's own values.

The worked `pr-review` example (#8734) is the first row behind a flag, and its first cut read
`featuresDefault.prReviewExample` — the compiled-in default record in `apps/tuval/src/features.ts`.
That is worse than the difference this record accepts: an operator doing exactly what 0363
prescribes, writing `features: {prReviewExample: true}` into `.tuval/tuval.config.ts` and
restarting, got a decoded flag and no row, and the only real "on" was editing shipped source.

## Decision

1. **A row's gate reads its own module's `features` block.** The config module names its stated flags
   once, as a const, and uses that const in both places — the `features` key of its default export
   and the conditional that builds the row. Turning the row on is editing that block and restarting,
   which is the operator gesture 0363 names.
2. **Nothing else changes.** Every reader that is not a row-registration decision keeps taking the
   merged record off `Features`. There is no second flag source and no new service.
3. **The layering difference is stated where it bites, not left to be discovered.** The flag's own
   docblock in `apps/tuval/src/features.ts` and the config module's `features` const both say that a
   row's flag is this layer's to state and that a lower layer stating it does not move the row.
4. **A row's flag key is still declared in `DeclaredFeatures`** (`apps/tuval/src/config.ts`), like
   any other, or the decode drops it and the browser side never sees it (#8595).

## Consequences

- An operator flips a row exactly as 0363 says: edit `.tuval/tuval.config.ts`, restart the desk.
- A global layer cannot add or remove a row in a project layer's config. That is a real narrowing of
  0363's merge, and it is the price of the row being built before the merge exists. It is also not
  obviously wrong on its own terms — a program row is code the project's config module builds, and a
  global layer naming a row it cannot import would have nothing to build.
- The next flag-gated row copies this shape rather than the `featuresDefault` read, which is what
  #8734's review caught.
- If a later change gives config evaluation access to a merged record, this record is the one to
  supersede: the gate becomes an ordinary `Features` read and the narrowing above goes away.

## Pointers

- `apps/tuval/.tuval/tuval.config.ts` — the `features` const and the row's gate
- `apps/tuval/src/features.ts` — `TuvalFeatures`, `featuresDefault`
- `apps/tuval/src/config.ts` — `DeclaredFeatures`, `loadLayeredConfig`
- `apps/tuval/src/feature-flags.ts`, `apps/tuval/src/boot.ts` — the `Features` service and the
  `Kernel` union's note on evaluation order
- ADR [0363](0363-tuval-feature-flags-in-config-file.md); #8595, #8734, epic #8716
