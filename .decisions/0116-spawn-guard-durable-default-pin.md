---
id: 0116
title: Spawn-Guard's Unset-Inherit Path Falls Back to a Committed DEFAULT_PIN, Not an Uncommitted Operator-Shell WORKFLOW_MODEL
status: accepted
date: 2026-06-27
tags: [pipeline, control-plane, spawn-guard, harness]
---

# 0116 — Spawn-Guard's Unset-Inherit Path Falls Back to a Committed `DEFAULT_PIN`

## Context

The spawn-guard (`packages/pipeline-cli/src/tools/spawn-guard/`) is a PreToolUse hook on
Task/Workflow spawns: it decides allow / allow-inherit / deny for the model a subagent
spawn runs on, fail-closed per ADR [0092](0092-gates-fail-closed-on-zero-scope.md). The
leak it kills is a silent off-allowlist spawn (the "tokens going brrrr" fable-5 spawn).

`#776` fixed a regression where an **unset** spawn request (the harness leaves
`tool_input.model` empty) was being denied: the guard tried to rewrite the request to the
`WORKFLOW_MODEL` pin id, but the Task tool's `model` field rejects the full id
`claude-opus-4-8[1m]`, so every inheriting spawn failed the schema and was blocked. The fix
returned **allow-inherit** — let the spawn ride the already-running session model rather
than force a pin — *but only when the `WORKFLOW_MODEL` env pin was itself on the allowlist*.

That allowlisted-pin condition is the fragility this ADR closes (issue #943). `WORKFLOW_MODEL`
is set **only in the operator's launching shell** — it is not committed in
`.claude/settings.json` (which sets only `PATH`). So `decideSpawn(req=null, pin=null)` —
an unset request with no in-shell pin — fell through to **deny**. A fresh clone, a CI or
cron launch, or a new operator without `WORKFLOW_MODEL` exported re-hit the exact #776
symptom: orchestrator subagent spawns denied. The escape hatch rested on uncommitted,
operator-specific env — undurable by construction.

The triaged decision (issue #943): **commit a durable default pin** vs **document
operator-responsibility and keep fail-closed-on-unset as intended.** This is platform/infra,
so engineering leads the call (ADR [0078](0078-product-driven-decisions-by-default.md)).

## Decision

**The unset-inherit path resolves an *effective pin*: `WORKFLOW_MODEL` when set, else a
committed `DEFAULT_PIN`** (`claude-opus-4-8[1m]`, a member of `ALLOWLIST`). The fallback
lives in the pure core (`spawn-guard.ts`), not in `.claude/settings.json` env — so it is
durable in source and shell-independent.

Concretely, in `decideSpawn(requested, pin)`:

- **Absent** env pin (`null`/empty/whitespace) → falls back to `DEFAULT_PIN`. An unset
  request then resolves to **allow-inherit** regardless of the launching shell; the
  decision carries `defaulted: true` so the `systemMessage` is honest ("committed default
  pin").
- **Present-but-off-allowlist** env pin (a real misconfiguration, e.g. `WORKFLOW_MODEL=claude-fable-5`)
  → **does not** silently fall back to the default; it still **denies**. Only an *absence*
  defaults; a *present wrong value* surfaces as the misconfiguration it is.

This is **not** a weakening of ADR 0092's fail-closed posture for the leak it targets:

- The leak ADR 0092/the guard exists to kill is an **explicit** off-allowlist spawn request.
  That is still denied — `decideSpawn("claude-fable-5", …)` → deny, unchanged.
- An unset request **never forces** a model; it inherits the **session** model (the pin is
  never injected — that was the whole #776 constraint). So the actual model an unset spawn
  runs on is identical before and after this change (the session model); only the **gate
  decision** flips from deny to allow. We stop *blocking* a spawn that was going to inherit
  the session model anyway — we do not introduce a new model into the spawn.

The committed default is the closed-form safe value: an allowlisted id resolved in source,
not an operator-shell variable that may or may not exist. "Fail closed" is satisfied by
resolving an absent pin to a known-good committed default, not by denying every
fresh-clone / CI / cron spawn.

## Consequences

- A launch with **no** `WORKFLOW_MODEL` in-shell (fresh clone, CI, cron, new operator)
  resolves unset spawns to allow-inherit — the #776 fail-closed-on-unset symptom no longer
  reproduces (issue #943 AC).
- The change is confined to the spawn-guard pure core + its `command.ts` renderer and tests;
  `.claude/settings.json` is untouched, so no self-mod-guard scripted-replace was needed and
  the §CP control-plane surface is the pipeline-cli package edit alone.
- `DEFAULT_PIN` must remain a member of `ALLOWLIST` (a unit test asserts this) — if the
  fleet's canonical model changes, both move together.
- A *misconfigured* `WORKFLOW_MODEL` (present, off-allowlist) still denies loudly rather than
  masking under the default, preserving the "a misconfigured pin can't smuggle a bad model"
  guarantee.
