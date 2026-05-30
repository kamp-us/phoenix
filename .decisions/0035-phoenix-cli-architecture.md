---
id: 0035
title: phoenix CLI architecture — programmatic composition, one package per verb
status: accepted
date: 2026-05-29
tags: [cli, tooling, packages, effect]
---

# 0035 — phoenix CLI architecture — programmatic composition, one package per verb

## Context

Phoenix needs CLIs for repo-local tooling — first up, a DO SQL migration
scaffolder for the topic DO's `state.storage.sql` schema
(`features/fate-live/migrations/topic/*.ts`). The natural question every time a small
CLI shows up is whether it earns its own package, or whether it should
land as a subcommand inside an `@phoenix/cli` monolith. The monolith form
is the default in most monorepos, and the default failure mode is also
well known: it grows into a kitchen sink where unrelated tools share a
release cadence, an argument parser, and a help surface that no one
navigates. Adding a command requires touching the central router;
deciding whether a tool is "big enough" gates new work.

The backend already runs on Effect, and `effect/unstable/cli` exposes
`Command` as a first-class value: commands compose by being combined
into trees, not by spawning processes. A focused CLI's root is a
`Command` value; a dispatcher's root is a `Command` value with the
focused roots passed to `Command.withSubcommands`. The same `Command.run`
helper turns either into an executable. That is the composition model
the rest of the worker's vocabulary already speaks; using `execvp` to
glue focused binaries together at the OS level would throw away the
typed composition Effect gives us for free.

## Decision

Phoenix CLIs split by verb, one package per focused CLI, and compose
**programmatically via Effect `Command` values** — not via OS `execvp` of
binaries on `PATH`. Each focused CLI exports a typed `Command` value
from its package; a future `phoenix` dispatcher imports those values and
combines them with `Command.withSubcommands([...])`, yielding a single
composed program that one shared Effect runtime dispatches.

### Three-level naming

For a focused CLI with verb `<verb>`:

- **Directory**: `packages/phoenix-<verb>/` — phoenix-prefixed for brand
  consistency, no scope in the path.
- **Package name**: `@kampus-phoenix/phoenix-<verb>` — scoped under
  `@kampus-phoenix` for npm namespacing.
- **Bin name**: `phoenix-<verb>` — what the user types in the terminal.

The three literal names align at the `phoenix-<verb>` token: directory,
the segment after the slash of the package name, and the bin. The
`@kampus-phoenix/` scope is the namespacing layer on top of that token.

### Two-file convention

Every CLI package — focused or dispatcher — has exactly two entry files:

- `src/index.ts` — the **programmatic API**. Exports `command` (the
  composed root `Command` value) and re-exports the subcommand values
  directly. No runtime invocation here; this file is import-safe.
- `src/bin.ts` — the **executable entry**. Imports `command` from
  `./index.ts`, hands it to `Command.run`, provides `NodeServices.layer`,
  and runs the result via `NodeRuntime.runMain`. This is what `bin` in
  `package.json` points at.

The dispatcher package (`packages/phoenix/`) follows the same shape:
`src/index.ts` builds a composed root by importing `command` values from
each focused CLI; `src/bin.ts` runs it. Both `phoenix migrate new ...`
(composed) and `phoenix-migrate new ...` (direct bin) execute identical
code through separate entry paths.

### `package.json` shape

```json
{
  "name": "@kampus-phoenix/phoenix-<verb>",
  "bin": { "phoenix-<verb>": "./src/bin.ts" },
  "exports": { ".": "./src/index.ts" }
}
```

`bin` points at the executable; `exports` exposes the programmatic API
to the dispatcher (and to any other workspace consumer that wants to
compose further).

## Rationale

- **Programmatic composition is what Effect's CLI primitive is designed
  for.** `Command` values compose; `Command.run` is the single sink that
  turns a composed root into a process. Going through `execvp` to do
  the same thing loses the typed composition, costs a process spawn per
  invocation, prevents shared services (e.g., a workspace-root resolver
  injected once into the dispatcher's runtime), and forks the help
  surface so `phoenix --help` cannot enumerate its subcommands without
  walking `PATH`.
- **Even a one-command CLI earns its package, because it's a citizen of
  a composable system.** The "is this tool big enough" gating question
  disappears — every CLI is its own package by default, so the
  threshold to add one is the same as adding any other package.
- **No central router to touch.** A new focused CLI lands as
  `packages/phoenix-<verb>/`; the dispatcher imports its `command`
  value and adds it to the subcommand list. The router is the
  dispatcher's `Command.withSubcommands` call, which is the only thing
  that changes per addition.
- **Independent testability.** Each focused CLI is testable as either a
  Node process (via its bin) or an imported `Command` value (via its
  `index.ts`). The dispatcher does not need to exist for any focused
  CLI to be exercised.
- **One Effect runtime, shared services.** The dispatcher's `bin.ts`
  provides the runtime once, and every subcommand reaches into the
  same `ServiceMap`. There is no per-binary cold-start tax and no
  duplicated layer wiring.

## Consequences

- **The dispatcher package ships when there are ≥2 focused CLIs.**
  Until then, direct bin invocation is the user-facing surface. The
  dispatcher's contract — import each focused CLI's `command` value,
  pass to `Command.withSubcommands`, run via `Command.run` — is fixed
  by this ADR, so adding it later is mechanical.
- **First focused CLI shipped: `@kampus-phoenix/phoenix-migrate`.**
  Single command `new` initially — `phoenix-migrate new <do> <name>`
  scaffolds a numbered `features/fate-live/migrations/<do>/<NNNN>_<name>.ts` file
  with the `SqliteMigrator` shape the topic DO's migrator loader
  (`topic-do.ts` `SqliteMigrator.fromGlob`) expects. The package
  layout — `package.json` with scoped name, `exports` of `./src/index.ts`,
  `bin` of `./src/bin.ts`, and the two-file split itself — is the
  reference shape every future CLI package follows.
- **Future tools follow the same shape.** Likely candidates:
  `@kampus-phoenix/phoenix-fate` (codegen / view introspection),
  `@kampus-phoenix/phoenix-stage` (dev/test stage lifecycle),
  `@kampus-phoenix/phoenix-sozluk` (the existing import script
  promoted from `apps/web/scripts/import-sozluk.ts` to a packaged
  binary). None block this ADR; each lands when it has a job, and
  each lands as an importable `command` value the dispatcher can
  compose.

### Workspace-bin gotcha

pnpm does **not** symlink a workspace package's own `bin` into its own
`node_modules/.bin`. Until another workspace package depends on a
focused CLI, the package cannot invoke its own bin as a bare
executable. The working pattern during dev within that package is
`pnpm --filter @kampus-phoenix/phoenix-<verb> run phoenix-<verb> <args>`,
where the `phoenix-<verb>` script runs the bin file directly via
`node --experimental-strip-types`. Once another workspace package
depends on the focused CLI (or once the dispatcher ships and depends on
all of them), pnpm's normal cross-package bin symlinking applies and
`phoenix-<verb> <args>` works directly. This is a pnpm behavior, not an
architectural property of the design.

## What was considered + rejected

- **Monolithic `@phoenix/cli` package with subcommands routed
  internally.** Rejected: every new command edits the central router;
  the "is this big enough to extract" question recurs forever;
  unrelated tools share a release cadence and an arg-parser config.
  The split-by-verb shape removes the gating question entirely.
- **Git-style `execvp` dispatcher.** Considered as the original model
  for this ADR. Rejected once the design crystallized around
  Effect-native composition: `execvp` loses the unified `--help`
  surface (the dispatcher can't enumerate subcommands without walking
  `PATH`), loses type-checked composition (the dispatcher has no
  compile-time knowledge of subcommand argument shapes), pays a
  process-spawn cost per invocation, and prevents the dispatcher's
  Effect runtime from sharing services with subcommands. The
  programmatic `Command.withSubcommands` model gives every property
  `execvp` was attractive for, with none of the costs.
- **Unscoped package names (`phoenix-migrate` as the package `name`).**
  Considered while modelling the directory/package/bin alignment.
  Rejected for the npm-namespacing reason: `@kampus-phoenix/*` keeps
  the workspace's packages under a single scope, matches the kampus
  org convention, and the three-level naming still aligns at the
  `phoenix-<verb>` token (directory, after-the-slash of the package
  name, bin), so nothing about the dispatcher composition or
  ergonomics suffers.
- **Skip the binaries; ship one `phoenix` ESM module with exported
  command functions, invoked via `pnpm dlx phoenix run <verb>`.**
  Rejected: the `pnpm dlx` indirection is friction every invocation
  pays for no gain; direct `phoenix-<verb>` invocation is the
  expectation set by every other CLI.

## See also

- [0029](0029-worker-runtime-servicemap.md) — Effect Context.Service in
  the worker; the same Effect vocabulary the CLIs use via
  `effect/unstable/cli`.
- [alchemy-stack-deploy.md](../.patterns/alchemy-stack-deploy.md) —
  the alchemy CLI's own architecture (a single binary, externally
  composed) is the inverse pattern this ADR diverges from for
  phoenix-owned tooling.
