---
id: 0103
title: "Consolidate Pipeline Tooling into One `@kampus/pipeline-cli`, Consumed by Plugin + CI"
status: accepted
date: 2026-06-20
tags: [pipeline, packages, plugin, ci, distribution]
---

# 0103 — Consolidate Pipeline Tooling into One `@kampus/pipeline-cli`, Consumed by Plugin + CI

## Context
The kamp.us agent pipeline's executable tooling is spread across ~8 `packages/*`: skill-invoked (`epic-ledger`, `decisions-index`), agent-session hook guards (`read-guard`, `worktree-guard`, `spawn-guard`), and CI checks (`leak-guard`, `doc-links`, `ci-required`). That fragmentation is the root of a recurring tax: per-package npm-publish (epic #803), `publish-guard` existing only to *derive which* packages a foreign install needs (#976/#979), the ADR-0100 §CP widening repeated per guard package, and genuine ambiguity about which packages reach a foreign consumer — `binclusive/monorepo`, which actively runs the plugin and hits the `pnpm dlx @latest` fallback today. Verified: a plugin ships its dir as-committed (no build step); `${CLAUDE_PLUGIN_ROOT}` is substituted in skill content; and a `SessionStart` hook + `${CLAUDE_PLUGIN_DATA}` is the documented pattern for installing a plugin's runtime deps once on the consumer. Supersedes [0064](0064-epic-ledger-npm-publish-automated-release.md) and [0076](0076-decisions-index-npm-publish-automated-release.md).

## Decision
Consolidate **all** pipeline tooling into a single **`@kampus/pipeline-cli`** package with subcommand dispatch (`pipeline-cli epic-ledger …`, `pipeline-cli spawn-guard …`, `pipeline-cli leak-guard …`, …) — one package, one Effect dep set, one version.
- **Install mechanism: npm.** `@kampus/pipeline-cli` publishes to npm — one package, always published, so there is no "which packages" to derive.
- **Consumed two ways:** (a) **Plugin (agent session)** — a `SessionStart` hook installs `@kampus/pipeline-cli` into `${CLAUDE_PLUGIN_DATA}` once (re-installs only on version change); skills and guard hooks invoke `pipeline-cli <tool>`. (b) **CI (phoenix + foreign)** — install `@kampus/pipeline-cli` as a dependency and run `pipeline-cli <tool>` in workflows; a foreign repo builds its CI integrations on these primitives.
- **Retire `publish-guard`** (its derivation — "which of many packages must publish" — is moot at one package) and its CI gate. **Simplify `publish.yml`** to publish the single package. The skill-CLIs' `pnpm dlx @kampus/<pkg>@latest` fallback is replaced by the SessionStart-installed `pipeline-cli`.

## Consequences
- **Supersedes ADR 0064** (epic-ledger npm publish) and **ADR 0076** (decisions-index npm publish) — both fold into the one `@kampus/pipeline-cli` publish.
- **Amends ADR 0100 (partial)** — the §CP boundary collapses from six guard packages to the one `@kampus/pipeline-cli` (it contains the guards, so it stays a self-weakening surface → control-plane); the principle stands, the surface shrinks. The §CP regex (ADR 0073 §6) is intended to update from `packages/*-guard/` to `packages/pipeline-cli/` — that regex edit is reorg-epic implementation, not this ADR.
- **Moots** the publish-guard derivation cluster (#976/#979, closed) and shrinks the §CP-drift surface (#955/#981) to one package.
- A foreign consumer gets the whole pipeline — skills + CLIs + guards + CI primitives — from one installable package, two install paths.
- **npm-publish is kept but radically simplified:** one package, one trusted-publisher registration, no derivation gate.
- **Cost:** a real reorg — 8 packages → 1 with a subcommand router; rewire `.claude/settings.json` (guard hooks → `pipeline-cli <guard>`), every CI workflow, and the plugin (+ its SessionStart deps-install hook). Executed as a follow-on epic, not this ADR.
