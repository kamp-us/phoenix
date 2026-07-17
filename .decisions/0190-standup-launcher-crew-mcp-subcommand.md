---
id: 0190
title: The stand-up launcher's mechanics live as a `pipeline-crew-mcp stand-up` subcommand (Effect CLI, pure core + thin bin), invoked by a thin plugin command — not as plugin-embedded Node
status: accepted
date: 2026-07-16
tags: [pipeline, pipeline-crew, crew-mcp, plugin, packaging, launcher]
---

# 0190 — The stand-up launcher lives in `pipeline-crew-mcp`, not in the plugin

## Context

The crew roster law (ADR [0189](0189-crew-roster-law-bridges-engines.md)) makes the
distributable `claude-plugins/pipeline-crew/` plugin the **sole** crew definition and calls
for a stand-up launcher (#3237) that boots the whole crew from one config: ensure the tracker
is running, assert the pinned Claude Code CLI version, then launch 3 bridge sessions + N engine
sessions, each bound to its own channel MCP server and holding its role lease. The launcher is
mechanical: config read, tracker-ensure, version assert, per-session bind construction, roster
session set, tmux placement, orchestration.

The epic (#3237) has a `type:decision` child (#3292) that must settle **where that mechanical
logic lives and what artifact form it takes** before any launcher code child (#3293–#3299,
each carrying `requires:#3292`) builds — it sets a distributability + package-boundary
precedent, so it is decided here first (engineering-led per ADR
[0078](0078-product-driven-decisions-by-default.md)). The plugin surfaces the stand-up as one
command either way; the fork is only *where the mechanics live*:

- **(A)** embedded in `claude-plugins/pipeline-crew/` as plugin-shipped Node code, or
- **(B)** as a new subcommand of the existing `packages/pipeline-crew-mcp/` bin — the crew's
  substrate package the plugin already references — that a thin plugin command invokes.

Three grounded facts settle it:

1. **CLAUDE.md's mechanical-tooling convention.** "Mechanical tooling lives as an Effect CLI
   package under `packages/` (the `epic-ledger` / `crabbox-manifest` / `leak-guard` idiom —
   `effect/unstable/cli`, run with `node src/bin.ts`) … A pure, unit-tested core + a thin
   Effect bin; never a one-off." The launcher *is* mechanical tooling.

2. **Plugin content is static, shared component files — not a home for testable mechanics.**
   Per the plugin spec, audited in the crew's own personalization seam
   ([`PERSONALIZATION.md`](../claude-plugins/pipeline-crew/PERSONALIZATION.md), grounded in the
   [Plugins reference](https://docs.claude.com/en/docs/claude-code/plugins-reference), the same
   source ADR [0171](0171-kampus-pipeline-plugin-spec-conformance.md) audited), plugin content
   is `agents/` / `commands/` / `skills/` / `hooks/` — the *same bytes* for every operator. A
   plugin `commands/` entry is a prompt surface, not a unit-testable core; there is no vitest
   seam inside plugin content. Embedding process-spawning / bind-construction Node there strands
   it exactly where the repo's test tier can't reach it.

3. **The substrate is already the runtime home.** #3211's founder ruling (2026-07-16) settled
   that the plugin **references** the in-repo `@kampus/pipeline-crew-mcp` package as its runtime
   prerequisite (nothing bundled; npm publish is a noted future unlock). The launch bind model
   (#3237/#3212) already bakes `pipeline-crew-mcp session --role <role> --project-root <root>`
   into each session's inline `--mcp-config` — so the launcher *must* already resolve the
   `pipeline-crew-mcp` bin to spawn every session. The package's `bin.ts` already ships peer
   subcommands (`session`, `tracker`) as `effect/unstable/cli` `Command`s over
   `NodeRuntime.runMain`, each with a pure, unit-tested core (`crew/`, `tracker/`, with
   `session.test.ts` / `tracker.test.ts`). A `stand-up` subcommand is the natural third peer.

**(B) does not fail on any real constraint.** The one plausible forcing constraint for (A) is
prerequisite resolution — "how does the thin plugin command reach the bin?" But the bind model
*already* requires the operator's environment to resolve `pipeline-crew-mcp` (each spawned
session's `--mcp-config` invokes it). A launcher that itself invokes `pipeline-crew-mcp
stand-up` needs the **identical** resolution it already forces on every child session — so it
introduces no new prerequisite. Today that resolution is the phoenix checkout / pnpm workspace
bin (`node src/bin.ts`, `"private": true`, unpublished); the future npm-publish unlock makes it
a globally-installed bin — neither changes the shape. (A) would be the one that pays a cost:
duplicating the config parse, roster read, and version assert as an untested second copy inside
plugin content, diverging from the substrate the sessions already run on.

## Decision

**The stand-up launcher's mechanical logic lives in `packages/pipeline-crew-mcp/` as a new
`stand-up` subcommand of its Effect CLI bin — option (B).** The plugin ships one **thin**
command that invokes it; the plugin carries **no** launcher Node code.

**Invocation surface.** The plugin's one operator-facing command (a slash command,
`claude-plugins/pipeline-crew/commands/stand-up.md`) invokes the referenced substrate bin:

```
pipeline-crew-mcp stand-up            # reads the operator's crew.config, ensures the tracker,
                                       # asserts the pinned CLI version, launches 3 bridges + N
                                       # engines, places them via tmux — fail-loud, no partial crew
```

The thin command holds no mechanics — it names the seam and shells to the subcommand, exactly
as the bind model already shells to `pipeline-crew-mcp session`. All logic lives in the tested
subcommand and its pure core modules.

**Home of each launcher child.** Every #3237 code child builds into `pipeline-crew-mcp`'s
source as a pure, unit-tested module, wired into the `stand-up` `Command` in `bin.ts`:

| Child | What it builds | Home (all under `packages/pipeline-crew-mcp/src/`) |
|---|---|---|
| #3293 | launch-dimension config schema + typed reader (CLI version, channel mode, engine count) on the personalization seam | a new `standup/config.ts` (+ `config.test.ts`) |
| #3294 | ensure-tracker-running (start-if-absent / reuse-if-present, standing process) | `standup/ensure-tracker.ts`, wrapping the existing `tracker/` `launchTracker` / `isTrackerAddressInUse` |
| #3295 | pinned-CLI-version assert — fail fast before any launch | `standup/version-assert.ts` |
| #3296 | per-session bind constructor — inline `--mcp-config` + channel registration flag (`--channels` / `--dangerously-load-development-channels`) | `standup/bind.ts` |
| #3297 | roster-driven session set — bridge×1 / engine×N by kind-typed cardinality + per-instance engine identity + role-lease binding | `standup/roster-set.ts`, consuming the kind-typed roster from `crew/roles.ts` (ADR 0189) |
| #3298 | tmux window-manager placement (tmux demoted from transport) | `standup/tmux-placement.ts` |
| #3299 | the one stand-up command — orchestrate version-assert → ensure-tracker → roster → bind → tmux → launch, fail-loud no partial crew, + plugin docs | the `stand-up` `Command` in `bin.ts` (+ orchestrator `standup/orchestrate.ts`) **and** the thin `claude-plugins/pipeline-crew/commands/stand-up.md` |

**Distributable-only.** The launcher references **only** the distributable
`claude-plugins/pipeline-crew/` plugin (its one thin command) and the `@kampus/pipeline-crew-mcp`
substrate package it already depends on. It references **no** operator-local / personal crew def
— not the paths, not the concept (per ADR 0189: the plugin is the sole crew definition; the
operator-local defs are deleted). All operator-specific values enter through the plugin's
personalization seam config (`crew.config.jsonc`), never a literal in the launcher.

**§CP classification.** Both homes are **NON-§CP**, so the launcher and every #3237 child ships
as ordinary work that auto-ships on green:

- `packages/pipeline-crew-mcp/` is not §CP (ADR [0187](0187-crew-mcp-is-not-control-plane.md):
  it coordinates the crew, it does not gate the pipeline; removed from the control-plane regex).
- `claude-plugins/pipeline-crew/` is deliberately outside the §CP boundary (epic #2342 founder
  ruling; the control-plane regex matches `claude-plugins/kampus-pipeline/{skills,agents,hooks}`
  and `packages/{ci-required,pipeline-cli}`, and matches **neither** crew path — verified
  against
  [`control-plane-re.ts`](../packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts)).

Downstream children inherit this: launcher PRs go through the review-code gate and auto-ship,
they do not bank for a §CP human merge.

## Consequences

- **The launcher is unit-testable.** Config read, version assert, bind construction, and roster
  cardinality get vitest coverage as pure functions in `pipeline-crew-mcp/src/standup/`, like
  `session`/`tracker` already do — a testability the plugin-embedded (A) form structurally
  cannot offer.
- **The plugin stays thin.** `claude-plugins/pipeline-crew/` gains exactly one `commands/`
  entry that shells to the substrate bin; it grows no Node code and no test surface. This is the
  first `commands/` in the plugin — it establishes the "thin command → substrate subcommand"
  shape for any future crew command.
- **One runtime, one prerequisite.** The launcher and the sessions it spawns run the *same*
  `pipeline-crew-mcp` bin; there is no second copy of the config/roster/version logic to keep in
  sync, and no new resolution prerequisite beyond the one the bind model already imposes.
- **The npm-publish unlock (#3211) applies uniformly.** When `@kampus/pipeline-crew-mcp` is
  published, the launcher subcommand ships with it — the plugin's thin command and every spawned
  session resolve the same published bin, no launcher-specific migration.
- **Precedent set.** Crew mechanical tooling belongs in the substrate package as an Effect-CLI
  subcommand with a thin plugin command over it — not embedded in plugin content. A future crew
  operation (not just stand-up) follows the same split by default; embedding mechanics in the
  plugin now requires justifying a departure from this ADR.
- **Blocks cleared.** #3292 is resolved; #3293–#3299 (all `requires:#3292`) unblock and build
  against a decided home.

Records the decision for child #3292 of epic #3237, grounded in ADR
[0189](0189-crew-roster-law-bridges-engines.md) (roster law), #3211 (plugin references the
substrate, npm publish future), ADR [0187](0187-crew-mcp-is-not-control-plane.md) (crew-mcp
non-§CP), ADR [0062](0062-repo-as-config-plugin.md) (repo-as-config seam the personalization
mirrors), and CLAUDE.md's Node-over-Python / Effect-CLI mechanical-tooling convention.

**No vocabulary impact** — this ADR re-decides the artifact home + form over already-named
concepts (launcher, bridge/engine roster, substrate, §CP); it coins no new term and redefines
none.
