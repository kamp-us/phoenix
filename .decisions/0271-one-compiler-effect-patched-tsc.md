---
id: 0271
title: one compiler — the stable native `tsc`, patched at install with the Effect language service
status: accepted
date: 2026-08-10
tags: [toolchain, typescript, effect, ci, dependencies]
---

# 0271 — one compiler: the stable native `tsc`, patched at install with the Effect language service

**What this decides:** phoenix compiles with exactly one binary. `typescript@7` (the native Go
compiler, shipped stable) provides `tsc`; `@effect/tsgo`'s `patch` swaps that binary for the
Effect-language-service build at `postinstall`. Emit (`build`/`prepublishOnly`) and type-check
(`typecheck`) run the same `tsc`, and `@typescript/native-preview` — the preview channel that used
to supply the `tsgo` bin — is dropped from the catalog.

## Context

The repo ran two compilers with no recorded rationale: three packages emitted with `tsc`
(`typescript@^6.0.3`), and every `typecheck` script ran `tsgo` from
`@typescript/native-preview@^7.0.0-dev.*`, whose binary `@effect/tsgo patch` overwrote in place with
the Effect build. [#4796](https://github.com/kamp-us/phoenix/issues/4796) asked whether
`typescript@7` — the same native compiler, now stable — lets the split collapse, and named two
mechanisms that could silently drop Effect diagnostics from `pnpm typecheck` if the compiler were
swapped naively. Both were measured against the real compiler before anything moved.

**Seam (a) — can `@effect/tsgo` attach to `typescript@7`? Yes.** `@effect/tsgo@0.36.4` was rebuilt
around exactly this: its `lib/getExePath.js` resolves `typescript` (then `@typescript/native`),
**requires major ≥ 7**, and matches the installed package's `gitHead` against the per-platform
`@effect/tsgo-<platform>-<arch>` package's `lib/upstream.json`. That manifest carries
`components.typescript["7.0.2"].gitHead = 2bd066d87f5bafd315be9f40889d0a60b9e58e0b`, which is the
`gitHead` the installed `typescript@7.0.2` declares. Run in the repo, `effect-tsgo patch` reports
`Patched typescript at …/@typescript/typescript-darwin-arm64/lib/tsc` — the same in-place binary
swap it used to perform on native-preview, now aimed at the stable compiler.

**Seam (b) — does stock `tsc` honor the `plugins` entry in a CLI run? No.** On a one-file project
extending the root `tsconfig.json` with `includeSuggestionsInTsc: true`, the Effect-patched compiler
emits `suggestion TS377016 … effect(effectSucceedWithVoid)`; the unpatched `typescript@7.0.2` `tsc`
emits nothing on the identical project. So the `plugins` entry alone buys nothing at the CLI: the
diagnostics come from the patched binary, not from the language-service package being installed.
This is why the collapse is a *retarget of the patch*, not a swap to stock `tsc`.

## Decision

1. Catalog `typescript: ^7.0.2` and `@effect/tsgo: ^0.36.4`; remove the
   `@typescript/native-preview` pin and its per-manifest `devDependencies` line.
2. Every `typecheck` script runs `tsc` instead of `tsgo` — including `apps/web`'s
   `tsc -b tsconfig.worker.json tsconfig.node.json && tsc -p tsconfig.app.json --composite false`.
3. `scripts/patch-effect-tsgo.mjs` — the #1800 backup-pruning wrapper (ADR
   [0038](0038-dependency-patches-local-only.md) tier-1) — keeps its job and changes its target: it now
   resolves `typescript`'s per-platform package instead of native-preview's. Its original failure
   mode is gone, though: read from the pinned `@effect/tsgo@0.36.4`'s `dist/effect-tsgo.cjs`, the
   only backup `patch` writes is a single `<bin>.original`, and when one already exists it renames
   the live binary to a `<bin>.<uuid>.patched` quarantine that its own cleanup list removes — the
   `.original.1`, `.2`, … accretion and its "Too many backup files exist" abort live only in the
   `0.5.x` line this upgrade leaves behind. So the wrapper is now a **regression guard**, not a live
   fix: it costs one restore plus a directory scan per install and holds the steady state at one
   `<tsc>` (patched) + one `<tsc>.original` (pristine) if a future version reintroduces accretion.
4. The root `tsconfig.json` `plugins` entry stays. It does not activate the diagnostics — the patched
   binary does — but it is what configures them (`includeSuggestionsInTsc: false`) and what the
   editor LSP reads.

## Consequences

- **One compiler, so emit and gate cannot disagree.** The old split's real cost was that a published
  artifact was built by a compiler no gate ever ran.
- **`@effect/tsgo` is now the single load-bearing Effect pin at the CLI.** It is not "invoked by a
  script" in the ordinary sense; it is the patch source for the binary every script runs, which is
  exactly why the pin must stay.
- **The upgrade surfaced five diagnostics, all fixed rather than suppressed.** Three
  `TS377105 floatingEffectInVitest` errors in `apps/web/worker/features/telemetry/Telemetry.unit.test.ts`
  were real: three tests returned an Effect from a plain `it()` callback, so Vitest never ran them —
  they now use `it.effect` and execute. Two `TS377033 multipleEffectProvide` warnings
  (`apps/web/alchemy.run.ts`, `infra/depo/doorman.ts`) were chained `Effect.provide` calls, rewritten
  as the equivalent single provide over a `Layer.provide`-built layer.
- **A `typescript` bump is now an Effect-diagnostics bump too.** `@effect/tsgo` ships artifacts keyed
  to specific `typescript` gitHeads, so the two pins move together: bumping `typescript` past what
  the installed `@effect/tsgo` carries makes `getExePath` throw rather than silently fall back.

## Alternatives considered

**Keep the split, just bump `typescript` to 7.** Cheapest diff, and it would have satisfied the
letter of the ticket. Rejected because seam (a) resolved cleanly: keeping a preview-channel compiler
alive next to a stable one that the Effect toolchain now targets is carrying a second toolchain for
no remaining reason.

**Move `typecheck` to stock `tsc` and rely on the `plugins` entry.** Rejected on the measurement in
seam (b): it silently drops every Effect diagnostic, which no test would catch.
