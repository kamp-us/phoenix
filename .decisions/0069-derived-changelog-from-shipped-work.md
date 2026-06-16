---
id: 0069
title: "Derive the changelog from shipped work — a batch CLI over closed-issue/merged-PR metadata at release time, not a per-ship CHANGELOG mutation"
status: accepted
date: 2026-06-15
tags: [pipeline, changelog, release, cli, ship-it, packaging]
---

# 0069 — Derive the changelog from shipped work

## Context

The issue→ship pipeline (`triage` → `plan-epic` → `review-plan` → `write-code` →
`review-code`/`review-doc` → `ship-it`) closes the loop one PR at a time: `write-code`
opens a PR that closes a triaged issue, a gate verifies it, and `ship-it` squash-merges
it. After the merge, **nothing collapses "what shipped" into a running, human-readable
record.** The repo has adjacent surfaces but none that answer *"what changed, and when"*
(issue [#181](https://github.com/kamp-us/phoenix/issues/181)):

- `README` = current state for builders.
- `.decisions/` = the *why* + history (ADRs).
- `.patterns/` = how the current code is shaped.

There is no `CHANGELOG.md`, the repo cuts **no release tags today** (`git tag` is empty),
and history lives only in `git log` and the GitHub closed-issue list. A reader who wants
"what's new" has to reconstruct it by hand, and that reconstruction drifts the instant
nobody maintains it.

The pipeline gives us a clean seam the raw git log does not: **every merged PR closes a
triaged issue with a known title and a triaged `type:*` label** (the
[`gh-issue-intake-formats.md`](../skills/gh-issue-intake-formats.md) contract). So a
changelog here is not "parse commit messages and hope" — it is a *projection* of
structured pipeline metadata that already exists. The open questions issue #181 explicitly
left to this decision: **per-ship vs per-release** derivation, and whether the mechanism
is **a skill, a CI step, or a doc convention**.

## Decision

**The changelog is a derived projection, computed by a batch CLI over closed-issue /
merged-PR metadata at release time — not a document a human (or a per-ship skill) edits by
hand.**

Concretely:

### 1. The artifact: a generated `CHANGELOG.md`, source-of-truth = the pipeline metadata

`CHANGELOG.md` lives at the repo root in [Keep a Changelog](https://keepachangelog.com)
shape (a `## [version] — date` section per release, entries grouped by category). It is a
**generated file**: its source of truth is the closed-issue/merged-PR metadata in GitHub,
not the file's own prose. The file is a cache of a projection, the same way fate's
generated types are a cache of the server schema (ADR
[0022](0022-server-types-single-source-of-truth.md)) — you regenerate it, you do not
hand-edit it.

### 2. The mechanism: an Effect CLI in `packages/`, not a skill and not a doc convention

Derivation is a **pure, unit-tested Effect CLI** under `packages/` — the
`epic-ledger` / `crabbox-manifest` / `leak-guard` idiom the repo already mandates for
mechanical tooling (CLAUDE.md "Node over Python for scripts/hooks"; ADR
[0035](0035-cli-conventions.md) naming). Working name **`changelog-derive`**: a pure core
(`deriveChangelog(entries) → markdown`, `groupByType`, `renderSection`) plus a thin
`effect/unstable/cli` bin run with `node packages/changelog-derive/src/bin.ts`.

Its inputs are the structured pipeline facts, in preference order:

1. **Closed-issue title + triaged `type:*` label** — the primary input. Each merged PR
   closes one such issue; the issue's `type:*` (from `gh-issue-intake-formats.md`) maps to
   a changelog category (`type:feature` → Added, `type:bug` → Fixed, `type:chore`/`type:refactor`
   → Changed, `type:decision` → Decisions/Changed, etc.). The exact map is the CLI's
   business and is unit-tested; this ADR fixes the *source*, not the table.
2. **Merged-PR title + number** — for the human-readable line and the `(#NNN)` backlink.
3. `git log` between tags only as the *range selector* (which merges fall in this release),
   never as the entry *text* — the text comes from the issue/PR metadata above.

### 3. The cadence: per-release (batch between tags), not per-ship

The CLI runs **at release time over the range since the previous release tag**, emitting
one `## [version]` section for everything that shipped in that range. It does **not** fire
per merged PR appending to an "Unreleased" heading.

### 4. The trigger: a `.github/workflows/` release step, keyed off the same release-tag convention ADR 0064 established

Derivation runs in CI on a release trigger — the **same `*-v*` release-tag convention ADR
[0064](0064-epic-ledger-npm-publish-automated-release.md) established for the epic-ledger
publish** (a published GitHub Release / `on: push: tags`). On that trigger the workflow
runs `changelog-derive` over the range since the prior release tag and commits the updated
`CHANGELOG.md`. `ship-it` is **not** modified: it stays the atomic, idempotent single-PR
merge actor (ADR [0048](0048-ship-it-merge-actor.md)); the changelog is a release-cadence
concern layered above it, not a per-merge side-effect bolted onto the merge actor.

## Options considered

**A. Per-ship skill: a new skill fires after `ship-it` merges, appends one entry to an
"Unreleased" heading in `CHANGELOG.md`.** This is issue #181's own non-binding sketch.
Rejected: (a) it makes `ship-it`'s "merge one PR" non-atomic — every merge now also mutates
a shared file, which races across the parallel-session pipeline (two ships touching the
same "Unreleased" block conflict) and breaks the "re-running ship-it is a clean no-op"
property (ADR 0048). (b) The skill would be **control-plane-adjacent**: a skill that runs
as part of the merge step, with write access to `main`, is exactly the gate/merge machinery
ADR [0065](0065-gate-critical-skills-are-blocking.md) makes blocking — needless friction
for a derived artifact. (c) It hand-maintains a file whose source of truth is elsewhere,
the drift this issue is trying to *kill*. (d) Skills are agent prose, not the place for
mechanical metadata transforms — CLAUDE.md routes that to a `packages/` CLI.

**B. Pure doc convention: a human appends to `CHANGELOG.md` per release.** Rejected
outright: it is the exact "lives only where someone remembers to write it, drifts the
moment nobody maintains it" failure #181 names. A convention with no mechanism is a TODO.

**C. A generic conventional-commits / `git log` changelog generator (e.g. an off-the-shelf
tool over commit messages).** Rejected: it discards the pipeline's structured advantage.
Phoenix already has *triaged issue titles + `type:*` labels* — far higher-signal than
parsing squash-commit subjects and hoping authors wrote conventional commits. An off-the-
shelf tool would also drag a dependency and a config surface for a projection we can write
in ~100 lines of tested core, and it would not understand the repo's own type taxonomy.

**D. The chosen option — batch CLI, per-release, CI-triggered, sourcing pipeline
metadata.** Chosen because it (a) keeps the changelog a *derived* artifact (regenerate, do
not hand-edit) so it cannot drift; (b) sources from the highest-signal facts the pipeline
already produces (closed-issue title + triaged type), not lossy commit text; (c) leaves
`ship-it` atomic and the merge step uncontaminated; (d) reuses the **already-decided**
release-tag convention and CI-publish shape from ADR 0064 instead of inventing a second
release concept; and (e) follows the repo's mandated `packages/` CLI idiom, so the core is
unit-testable and the projection is one source of truth.

## Consequences

- **Implementation is follow-up work, filed.** This ADR records the decision only. The
  build — the `packages/changelog-derive` CLI (pure core + Effect bin), the `type:*` →
  category map, the `.github/workflows/` release step, and the initial `CHANGELOG.md` —
  is tracked as issue [#394](https://github.com/kamp-us/phoenix/issues/394)
  (`status:needs-triage`, milestone 1). The workflow file lands under `.github/**`, so per
  ADR [0053](0053-control-plane-boundary.md) that PR is **control-plane → human-merged**
  (same as ADR 0064's publish workflow); the CLI itself (`packages/**`) and the generated
  `CHANGELOG.md` (repo root) are non-blocking and auto-merge once gated.
- **No release tags exist yet.** The CLI's range selector needs a prior tag; until the repo
  cuts its first release tag (the `*-v*` convention ADR 0064 introduced), the first run
  derives from the start of history. The implementation issue owns that bootstrap.
- **A new standing input contract.** The derivation depends on `write-code` PRs continuing
  to close exactly one triaged issue carrying a `type:*` label (the
  `gh-issue-intake-formats.md` contract) — the same invariant the rest of the pipeline
  already relies on, so no new discipline, but the changelog now *reads* it, so a PR that
  closes no issue or an issue with no `type:*` produces an "Uncategorized" entry the CLI
  flags rather than silently dropping.
- **`ship-it` is untouched.** The merge actor stays atomic and idempotent (ADR 0048); the
  changelog is computed at release cadence, decoupled from individual merges.
- **Relationship to ADR 0064.** This ADR *reuses* 0064's release-tag/CI-publish convention
  as the trigger; it does not supersede or amend it. Cutting a release becomes a single act
  that can drive both the epic-ledger publish (0064) and the changelog derivation (0069).
