---
id: 0291
title: The kampus-pipeline Plugin Is Retired — Deleted, Not Frozen
status: accepted
date: 2026-08-19
tags: [pipeline, fabrika, control-plane, retirement]
---

# The kampus-pipeline Plugin Is Retired — Deleted, Not Frozen

## Decision

`claude-plugins/kampus-pipeline/` is deleted — skills, agents, hooks, shared lib, shim and
marketplace entry — together with everything that existed only to serve it. **fabrika is the one
pipeline** (founder ruling, 2026-08-18, recorded at ruling time on
[#5937](https://github.com/kamp-us/phoenix/issues/5937)).

## Why

M45 made fabrika the pipeline. Keeping v1 on disk after that was the split-brain that milestone
existed to end: two skill rosters answering the same names, guards scanning a corpus nothing runs,
hooks in `.claude/settings.json` executing code from a plugin marked disabled, and every doc
having to say which pipeline it meant. Earlier retirements kept the tree — ADR 0277 kept the
plugin suppressed-but-present, ADR 0279 retired the crew but left the corpus as "the frozen
comparison baseline" — and the baseline role expired too: ADR 0238 already banned fabrika from
calling or porting v1, and #4638 banned it as a source of truth.

## What went with the tree

- **Hooks and the marketplace entry.** The ten v1 hook commands leave `.claude/settings.json`
  (fabrika's hook surface is `claude-plugins/fabrika/hooks.json`, ADR 0250); the `kampus-pipeline`
  marketplace entry and its `enabledPlugins` suppression (ADR 0277's mechanism — moot with nothing
  to suppress) are removed. `.claude/workflows/drive-issue.js`, the v1 orchestrator that spawned
  the v1 crew, is deleted with it.
- **Corpus guards.** `trap-status-guard.yml`, `cli-invocation-guard.yml` and `adoption-lint.yml`
  scanned the retiring script corpus and fail closed on an empty surface (ADR 0092), so they
  retire with it, along with their pipeline-cli tools (`trap-status-guard`,
  `cli-invocation-guard`, `adoption-lint`) and the v1-only classifiers `class-probe` and the
  ship-it contract-pin modules. The bash-3.2 shape they enforced remains recorded in
  `.patterns/skill-script-shell-shape.md` and still binds the shell the repo keeps (workflow
  `run:` blocks, git-hook bodies).
- **The ci.yml `skills` job.** Its v1 validators are gone; the job keeps its
  `validate skill frontmatter` check name (a required status check on `main` — renaming it
  silently strips the requirement) and now carries the #5605 marketplace-source guard inline.
  Re-pointing the ruleset at an honest name is follow-up work, not this deletion's.
- **The §CP boundary.** The four `claude-plugins/kampus-pipeline/*` clauses leave
  `CONTROL_PLANE_RE` and `.github/CODEOWNERS` (they classified paths that can no longer exist —
  ADR 0227 is superseded on that point). The un-importable prose copy of the boundary moved from
  the v1 formats doc to `packages/pipeline-cli/src/tools/control-plane-paths/boundaries.md`,
  itself inside the §CP tree; `codeowners-cp check` still holds const, prose line and CODEOWNERS
  in lockstep (#2761), and `cp-classify`/`trivial-diff` still resolve the boundary from
  `origin/main` (#981).

## What this does not decide

The remaining pipeline-cli verbs whose only callers were v1 scripts (e.g. `drive-issue-flow`,
`worktree-sweep`'s hook path) are left registered; sweeping them is separate follow-up work.
ADRs and dated reports keep their references to the deleted tree as history — `.decisions/` is
the why + history surface, and history does not get rewritten when its subject dies.
