---
id: 0036
title: features/ is any named app-level grouping, not just product domains
status: accepted
date: 2026-05-30
tags: [architecture, conventions, worker, layout]
---

# 0036 — features/ is any named app-level grouping, not just product domains

## Context

The worker used to be organized by technical layer. There was a `services/`
bucket for Effect services, a `shared/` bucket for cross-cutting utilities, an
`infra/` bucket for runtime/transport plumbing, and product code (sozluk, pano,
vote, stats) sat alongside as siblings of those buckets. Anything that didn't
obviously belong in one bucket grew its own — `auth/`, `admin/`, `runtime/`
were all on the table at one point or another.

The failure mode of layer-organization is the standard one: a single feature's
code spreads across several folders. The sozluk handler lived under one tree,
its services under another, its admin transport under a third, and its
mutations near the resolvers. Reading "what does sozluk do" required walking
four directories and reconstructing the connections in your head. Adding a new
feature meant deciding which bucket each new file belonged in, every time.

The feature-colocation restructure (the chunk-1/2/3 trilogy that landed in
`1dfbcef → 1e7f762 → 2c5f354`) dissolved the technical buckets and moved every
named app concern into its own folder under `worker/features/`. With that move
done, the question became: what exactly counts as a "feature"? Plan v4 flagged
the answer as a future ADR. This is that ADR.

## Decision

`worker/features/` is the home for **any named app-level grouping** — product
domains, framework concerns, and single-file utilities alike. The unifying
principle is "a coherent named chunk of app code, even if it's small."

The worker has exactly five top-level concepts:

```
worker/
├── index.ts        # the worker entry — DO host, bindings, env block
├── env.ts          # deploy-time env resolver + runtime env type
├── db/             # D1 binding, Drizzle schema, migrations, keyset cursors
├── http/           # app composition, admin transport, admin-auth
└── features/       # everything else, each in its own named folder
```

There is no `services/`, `shared/`, `infra/`, `auth/`, `admin/`, `runtime/`.
Those buckets dissolved on purpose and don't come back.

### What's a feature

Anything with a name worth grouping. Current residents of `features/`:

- **Product domains** — `sozluk/`, `pano/`, `vote/`, `stats/`. The user-facing
  surfaces. Read-write (sozluk, pano), mutation-only (vote),
  query-only (stats).
- **Framework concerns** — `fate/`, `fate-live/`. The data-layer plumbing
  that ADR 0015/0023/0034 describe. They earn the same folder shape as
  product domains because they are named, coherent groupings of code.
- **Auth** — `pasaport/`. The better-auth fork + session capability +
  middleware. One named grouping, one folder.
- **Single-file utilities** — `text/`. `features/text/index.ts` is one
  function (`excerpt()`). It still gets its own folder because it has a
  name and the convention is uniform.

Not every feature exposes every file. The per-feature footprint that
fate-shaped features tend to grow into is `queries.ts` / `lists.ts` /
`views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts`, but `vote/` is
mutation-only and `stats/` is query-only. A feature only ships the parts it
actually exposes.

### What's NOT under features/

The runtime context shells. These are the four siblings of `features/`:

- **`index.ts`** — the worker entry, the alchemy `Worker` declaration, the
  `env` block, the DO-host glue.
- **`env.ts`** — deploy-time env resolution (the `process.env` snapshot
  alchemy sees at deploy time) and the runtime `WorkerEnv` type.
- **`db/`** — the database layer end-to-end: D1 binding, Drizzle schema,
  migrations, `keyset.ts` cursor helpers.
- **`http/`** — app composition (the router root), the admin transport,
  admin-auth.

These aren't features because they aren't named app concerns — they're the
shell every feature runs inside. Moving `db/` into `features/db/` would be a
category error: it's the substrate, not a slice of product/framework code.

## Rationale

- **Technical-layer organization fights against feature locality.** When the
  buckets were `services/` / `shared/` / `infra/`, the act of reading a
  feature required reconstructing it from pieces scattered across the tree.
  Feature-colocation collapses that reconstruction — one folder, one
  feature, everything the feature owns is right there.
- **The "is this a feature?" question has a simple test.** If it has a name
  worth grouping and lives at the application level (not the runtime
  shell), it goes under `features/`. The test is uniform whether the
  thing is a product domain, a framework concern, or a single utility
  function. There's no minimum size — `text/` with one function is still a
  feature.
- **The convention is predictable enough to scaffold.** Because every
  feature lives at the same depth with the same shape, future tooling can
  assume the convention. `phoenix-fate new <feature>` (the CLI shape ADR
  0035 sketches) can scaffold a predictable per-feature footprint without
  per-feature configuration.
- **One discipline replaces many.** Instead of "should this go in
  `services/` or `shared/` or `infra/`?", the only question when adding a
  new concern is "is this an app-level grouping with a name?" If yes →
  `features/<name>/`. If no → it's runtime context (`index.ts` / `env.ts`
  / `db/` / `http/`).

## Consequences

- **Per-feature aggregators replace the dissolved technical buckets.** For
  example, `features/fate/` now owns the fate-layer composition that used
  to live in a top-level `runtime/` or `services/` shape. Barrels inside
  each feature folder preserve the SPA's import surface so the migration
  was non-breaking for downstream code.
- **Future CLI / scaffolding tools can assume the convention.** ADR 0035's
  `phoenix-fate new <feature>` (and any future verb) can generate the
  standard per-feature footprint without configuration. The convention is
  the API.
- **The convention requires discipline.** When adding new code, ask: "is
  this an app-level grouping with a name?" If yes, it's a feature folder.
  If no — if it's part of the runtime shell, the DB, the HTTP composition,
  the env wiring — it belongs in one of the four siblings of `features/`,
  not in `features/` itself. The temptation to grow a `features/shared/`
  or `features/util/` is what this ADR is meant to prevent.
- **No `worker/<one-off>.ts` files.** A loose top-level file (the
  considered-and-rejected `worker/text.ts` shape) bypasses the convention
  and re-opens the "what's the rule?" question. Every named grouping is a
  folder; the folder is the unit.

### `features/text/` validates the "any named grouping" claim

`features/text/` is the smallest possible feature: one file
(`index.ts`) exporting one utility function (`excerpt(body, max)`). No
`Context.Service`, no fate fragments (no `queries.ts` / `views.ts` /
`mutations.ts`), no errors, no Layer. It still gets its own folder because
text-processing is a coherent named concern at the application level — the
`excerpt` rule is called from `SozlukAdmin` (140-char definition cards) and
`Pano` (280-char comment excerpts) and would otherwise be duplicated inline.
The folder shape is uniform across the worker; `text/` paying the one-line
cost of being a folder is the price of that uniformity.

This is **not** a license to dump every helper into `features/`. The bar is
"has a coherent name worth grouping under." `text/` qualifies because
text-processing is a named concern that future text utilities (slugification,
HTML sanitization, etc.) would land in. A generic `string-utils.ts`,
`misc-helpers.ts`, or `format.ts` does not qualify — it has no domain, it
collects whatever didn't fit elsewhere, and it's the kind of catch-all that
`features/shared/` was pre-emptively rejected for. If a utility doesn't have
a coherent named home in an existing feature or in a new named feature, the
right move is to keep it inline at its single call site until the second
caller forces the abstraction.

## What was considered + rejected

- **Technical-layer organization (`services/` / `shared/` / `infra/`).**
  The previous shape. Rejected because it spreads each feature across
  multiple folders and forces a bucket-assignment decision per file. See
  commits `1dfbcef`, `1e7f762`, `2c5f354` for the dissolution.
- **Top-level single-file utilities (e.g., `worker/text.ts`).** Considered
  for `text/` specifically — it's one function, why not just a file? —
  and rejected as "weird" because it lacks the named-grouping framing
  that every other piece of app code follows. A folder with one file is
  not a cost; a special case is.
- **A `features/shared/` escape hatch for cross-feature utilities.**
  Rejected pre-emptively. The reason `shared/` was dissolved at the
  top level applies again one level deeper: it becomes a graveyard.
  Cross-feature utilities either belong in one of the features (the
  one that originates the abstraction) or are runtime context (under
  `db/` / `http/`).

## See also

- [0035](0035-phoenix-cli-architecture.md) — the CLI architecture builds on
  this convention. `phoenix-fate new <feature>` assumes the per-feature
  shape this ADR fixes.
- [feature-services.md](../.patterns/feature-services.md) — the per-feature
  service shape that feature folders host.
- [effect-layer-composition.md](../.patterns/effect-layer-composition.md) —
  parameterized layer factories live with their features, not in a shared
  bucket.
