---
id: 0282
title: The Spawn-Guard Is Retired — Deleted, Not Re-Pinned
status: accepted
date: 2026-08-16
tags: [pipeline, control-plane, spawn-guard, harness]
---

# 0282 — The Spawn-Guard Is Retired — Deleted, Not Re-Pinned

## Context

The v1 spawn-guard (`packages/pipeline-cli/src/tools/spawn-guard/`) gated every
Task/Workflow spawn against an allowlist holding only the Opus 4.8 family, while sessions
now run Opus 5. An unset `model` still resolved to allow-inherit via the committed
`DEFAULT_PIN` (ADR [0116](0116-spawn-guard-durable-default-pin.md)), so the stale list was
latent on the normal path — what it denied was any explicit non-4.8 model parameter and any
new-generation `WORKFLOW_MODEL` pin. #3978 asked to widen the allowlist and was closed
NOT_PLANNED in the v1-corpus kill batch (#4642); the defect it named stayed in the tree.

The founder ruled on 2026-08-14 (recorded in #5539): the guard is unnecessary and goes away
— no re-pinning, no widening, no config-driven tier seam. Nothing replaces it.

## Decision

**Delete the spawn-guard in full** (#5539): the tool directory, its `pipeline-cli` registry
entry, both hook wirings (`.claude/settings.json` and
`claude-plugins/kampus-pipeline/hooks.json` — the `Task|Workflow` PreToolUse guard and the
SessionStart freshness check), and the `guard.sh` usage lines naming it.

`formatSessionCost` / `SessionCostInput` — the per-session cost renderer the guard's
`statusline` mode carried — outlived the guard: `token-spend` was its one remaining
consumer, so it moved to `packages/pipeline-cli/src/tools/token-spend/session-cost.ts`.

## Consequences

- The v1 `pipeline-cli` guard no longer gates explicit-model spawns — the #5539 ruling
  reaches exactly that tool. Fabrika's own `fabrika hook spawn` (`Task|Workflow`
  PreToolUse, reimplemented from v1 per ADR
  [0238](0238-fabrika-reimplements-v1-never-calls-it.md) and governed by ADR
  [0250](0250-fabrika-hook-cannot-run-fails-open.md)) still gates spawns at head and
  stands; retiring it would be its own tracked decision, not this record's.
- ADR 0116 (and ADR [0092](0092-gates-fail-closed-on-zero-scope.md)'s spawn-guard examples)
  now describe retired machinery. Both stand unedited as history; this ADR is the
  retirement record. ADR 0092's fail-closed rule itself is untouched — the other guards
  still hold it.
- The SessionStart freshness signal (#835) retired with the tool; a degraded hook-pack tree
  no longer announces itself at session start.
- #5540 owns retiring the remaining v1 hook entries; the two removed here are out of its
  scope.

> Amendment 2026-08-20: the tracked decision this record deferred to has landed — ADR [0331](0331-fabrika-spawn-hook-retired.md) retires `fabrika hook spawn` on the same reasoning, so the ruling here now reaches both copies and no spawn guard survives anywhere.
