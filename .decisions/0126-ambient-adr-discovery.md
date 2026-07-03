---
id: 0126
title: "Ambient ADR discovery — delete the committed `index.md`; frontmatter is the row, a SessionStart hook injects the compact map (the skills-discovery pattern; supersedes [0066](0066-generate-decisions-index.md)'s storage half after the main ruleset broke the regenerate push, #1718)"
status: accepted
date: 2026-07-03
tags: [decisions, pipeline, docs, autonomy]
---

# 0126 — Ambient ADR discovery: no committed index, frontmatter + SessionStart hook

## Context

Supersedes [0066](0066-generate-decisions-index.md).

ADR 0066 made `.decisions/index.md` fully **derived** (generated from ADR frontmatter by
`pipeline-cli decisions-index`) to kill the tail-conflict every concurrent ADR PR hit — but it
kept the derived output **committed**, refreshed by a `regenerate` job that pushes to main as
`github-actions[bot]` after each merge.

That write path is now structurally dead: the main ruleset requires all changes through a PR
(GH013 — verified by reproducing the rejected push, #1718), so every regenerate attempt fails
and the committed index silently drifts (0125 landed with no row). The founder's invariant is
explicit and broader than the incident: **no commit on main's history without a PR behind it,
ever** — a bot bypass is rejected on principle, not just mechanics. Defending the committed
cache with an auto-merged bot PR was considered and rejected as machinery whose only job is
keeping derived state warm.

The counter-pressure is discoverability: the index is the **agents' entry point** (CLAUDE.md's
"read the row, open the file"). Deleting it with no replacement means agents skip ADR grounding —
the most expensive failure mode this repo has. The skills system already solved this exact
problem shape: no committed catalog, frontmatter is the row, a loader surfaces the list into
context ambiently.

## Decision

1. **`.decisions/index.md` is deleted and never committed again.** Derived state leaves version
   control; main history stays 100% PR-connected. The `regenerate` job of
   `.github/workflows/decisions-index.yml` is removed with it.
2. **Frontmatter is the row** (already true — `id`/`title`/`status`/`date`/`tags` are what the
   generator read). Filenames keep encoding `NNNN-slug` so `ls .decisions/` alone is a usable map.
3. **Discovery goes ambient, the skills way:** a repo `SessionStart` hook injects the compact ADR
   map — one line per ADR (`id · title · status`), emitted by a `pipeline-cli decisions-index`
   compact/stdout mode — into every session's context. Agents never run anything by hand.
4. **The PR-side `validate` job stays** — duplicate-`id` / filename-mismatch catching (the ADR
   0074 number-lock backstop) is load-bearing and unaffected.
5. **Fallback contract for contexts without the hook** (subagents don't inherit session context):
   CLAUDE.md states the map is `ls .decisions/` + frontmatter. No script required to discover.

Implementation rides #1718, split product-plane (index/file/CLI/doc changes — auto-ship) vs
control-plane (settings hook + workflow change — human merge per ADR 0053).

## Consequences

- Nothing exists to drift: the failure class of #1718 is deleted, not patched. No bot pushes, no
  trailing PRs, no staleness window, no gate carve-outs.
- Every session pays a small token cost for the injected map (~one line per ADR). This prices in
  a real pressure to keep frontmatter `title`s to one dense line — paragraph-length titles (this
  repo has several) now cost every session, and should shrink over time.
- Subagents that don't receive SessionStart context rely on the `ls` + frontmatter fallback —
  strictly worse than the injected map, strictly better than a stale index.
- The clickable table on github.com is gone. Accepted: the repo's readers are the founders and
  agents, all of whom have the map injected or one `ls` away.
- The `/adr` skill and CLAUDE.md drop their index-row/regenerate language; ADR PRs remain purely
  additive (one new file, plus the superseded file's status edit when superseding).
