---
id: 0457
title: Effect diagnostics come from a second `typecheck` step, never from a compiler patched at install
status: accepted
date: 2026-10-04
tags: [toolchain, typescript, effect, ci, dependencies]
---

# 0457 — Effect diagnostics come from a second `typecheck` step, never from a compiler patched at install

**What this decides:** every package's `typecheck` runs the stock `tsc` and then
`effect-tsgo diagnostics --project tsconfig.json --strict`, and nothing rewrites the compiler binary
when dependencies install.

## Context

ADR [0271](0271-one-compiler-effect-patched-tsc.md) put the Effect language-service diagnostics
inside the compiler: a root `postinstall` ran `effect-tsgo patch`, which swapped `typescript@7`'s
native `tsc` binary for the Effect build. That made the gate depend on state in `node_modules` that
git does not carry.

A fabrika agent worktree never got that state. `lefthook.yml`'s `post-checkout` `bootstrap-deps`
installs with `--ignore-scripts`, so the root `postinstall` was skipped and the worktree held a
complete, lockfile-correct `node_modules` with a pristine compiler. That compiler dropped every
Effect diagnostic and exited 0, and nothing said it was unpatched. On epic
[#7499](https://github.com/kamp-us/phoenix/issues/7499) child
[#7560](https://github.com/kamp-us/phoenix/issues/7560) spent two review rounds against that false
green ([#7804](https://github.com/kamp-us/phoenix/issues/7804)).

The founder ruled option 3 on #7804 on 2026-09-04: drop the patch and run the diagnostics as their
own step. [PR #7807](https://github.com/kamp-us/phoenix/pull/7807) shipped it and left `.decisions/`
untouched, so 0271 kept reading `accepted` for machinery that no longer existed.
[#7816](https://github.com/kamp-us/phoenix/issues/7816) asked which record should carry the ruling,
and [its ruling](https://github.com/kamp-us/phoenix/issues/7816#issuecomment-5625052044) chose a new
ADR that supersedes 0271. This is that record.

## Decision

**Effect language-service diagnostics are a separate CLI step in every package's `typecheck`, and no
install step patches the compiler.**

1. A package's `typecheck` runs its `tsc` command, then
   `effect-tsgo diagnostics --project tsconfig.json --strict`. A package with more than one tsconfig
   lens runs the pair once per lens.
2. There is no root `postinstall` and no `scripts/patch-effect-tsgo.mjs`. Both commands run off
   `node_modules/.bin` against the binaries the lockfile installed.
3. `--strict` is required. Without it a `warning`-severity diagnostic prints and the command exits
   0. Measured on `@effect/tsgo@0.36.4` with a one-file project holding
   `Effect.fail(new Error("x"))`: stock `tsc` exits 0 and prints nothing, `effect-tsgo diagnostics`
   prints `effect(globalErrorInEffectFailure)` and exits 0, and the same command with `--strict`
   exits 1.
4. Each package that runs the step declares `"@effect/tsgo": "catalog:"` itself, so the bin resolves
   from the package that invokes it.

**Carried over from 0271.** These parts of the superseded record still hold, and this record is now
their home:

- `typescript@7`'s native `tsc` is the one compiler. Emit (`build`, `prepublishOnly`) and
  `typecheck` run the same binary, and `@typescript/native-preview` stays out of the catalog.
- The root `tsconfig.json` `plugins` entry stays. It configures the diagnostics and is what the
  editor's language server reads.

**Binding constraints.**

- No install-time script may modify the `tsc` binary.
- A `typecheck` script keeps both steps. Stock `tsc` passes every Effect diagnostic, and a report
  folded into [#7804](https://github.com/kamp-us/phoenix/issues/7804#issuecomment-5545984716)
  records ordinary type errors that `effect-tsgo diagnostics --strict` passed and `tsc` caught.

## Consequences

- **One gate everywhere.** CI, an agent worktree and a developer's machine run the same two commands
  over the same installed binaries. `--ignore-scripts` no longer changes what `typecheck` sees.
- **The script shape is copied into every manifest.**
  `packages/fabrika-cli/src/typecheck-shape.repo.test.ts` reads the live manifests and reds when a
  package omits either half, runs `effect-tsgo` without declaring it, or when a root `postinstall`
  returns.
- **Two passes cost more than one.** Each project is read twice per `typecheck`.
- **A checkout installed before the change may still hold a patched `tsc`.**
  [.patterns/typecheck-two-step.md](../.patterns/typecheck-two-step.md) carries the fix, and it is
  the home for the script shape and how to add a package.
