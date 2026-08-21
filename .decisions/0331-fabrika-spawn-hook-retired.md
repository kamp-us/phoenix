---
id: 0331
title: fabrika's rebuilt spawn hook is retired — 0282's ruling reaches fabrika
status: accepted
date: 2026-08-20
tags: [fabrika, hooks, spawn-guard, control-plane, harness]
---

# 0331 — fabrika's rebuilt spawn hook is retired — 0282's ruling reaches fabrika

**What this decides:** `fabrika hook spawn` — the `PreToolUse` model-allowlist guard on
`Task|Workflow` — is deleted. The verb, its pure decision, its tests and its `hooks.json`
declaration all go. `fabrika hook check` on `SessionStart` is untouched and stays.

Founder ruling of 2026-08-20, on the fast path: landed without the fabrika review pipeline by
explicit authorization.

## Context

ADR [0282](0282-spawn-guard-retired.md) retired v1's spawn-guard on a founder ruling of 2026-08-14:
the guard is unnecessary, "deleted, not re-pinned", and **nothing replaces it**. That record scoped
itself to the v1 tool and left fabrika's own copy standing, on the reasoning that retiring it "would
be its own tracked decision, not this record's". This is that decision.

fabrika had rebuilt the same guard anyway, per ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md)'s reimplement-never-call rule: a
`PreToolUse` hook on `Task|Workflow` that read `tool_input.model` off the harness envelope,
resolved a `WORKFLOW_MODEL` pin against a committed default (ADR
[0116](0116-spawn-guard-durable-default-pin.md)), and returned allow / allow-inherit / deny. So the
thing 0282 killed came back under a new name, a week later, with the same failure mode intact.

## Decision

**Delete it.** Three reasons, all of them the founder's:

1. **Model discipline is a per-run human choice.** Which model a lane runs on is named at the spawn,
   by the person driving the fleet. A committed allowlist is a second, staler opinion about a
   decision that already has an owner.
2. **A stale allowlist denying a new model generation is the guard's proven failure mode, not a
   hypothetical.** It is exactly what happened in v1: the list held only the Opus 4.8 family while
   sessions ran Opus 5, #3978 asked to widen it and was closed unactioned, and the defect sat in the
   tree until 0282 deleted the whole tool. Rebuilding the guard rebuilds that clock.
3. **The hook does not fire on most of the fleet anyway.** Other harnesses the fleet runs on
   (opencode, pi) never invoke a Claude Code `PreToolUse` hook, and ADR
   [0250](0250-fabrika-hook-cannot-run-fails-open.md) rules the cannot-run state fails **open**. So
   the guard's actual coverage was one harness, and a defence that covers some spawns and not others
   is not a defence — it is a false sense of one.

What goes: `packages/fabrika-cli/src/hook/spawn.ts`, `spawn-verb.ts` and their three test files; the
`spawn` leaf in the `hook` group's command wiring; the `PreToolUse` block in
`claude-plugins/fabrika/hooks.json`; and the live doc rows naming the verb.

What stays: `fabrika hook check` on `SessionStart`, whole and unedited — it answers a question and
blocks nothing, which is the whole surface's remaining job.
`packages/fabrika-cli/src/models.ts` also stays, demoted from a gate's table to plain vocabulary:
the canonical model ids and their harness aliases, for a reader, enforcing nothing.

## Consequences

- **No fabrika hook decides anything.** The surface is one `SessionStart` reader. Nothing fabrika
  declares can deny a tool call, which makes ADR 0250's fail-open polarity vacuous in practice while
  still worth pinning — `pretooluse-polarity.cli.test.ts` survives, now driving the `SessionStart`
  row, so a future `PreToolUse` declaration cannot inherit a bootstrap that exits on the harness's
  blocking code `2`.
- **An off-allowlist spawn now runs.** That is the point, not a regression: the token exposure ADR
  0282 accepted for v1 is accepted here on the same reasoning, and the mitigation is the same one —
  a human names the model.
- **ADRs 0116, 0238 and 0250 now describe retired machinery in part.** They stand unedited as
  history; this is the retirement record. 0116's 2026-08-19 amendment pointed at
  `hook/spawn.ts` as the live home of the unset-inherit split — that home is gone, and the pin
  constants it also named live on in `models.ts` as vocabulary.
- **The `hook` group's exit table keeps a seat nothing reaches.** `WRONG_EVENT` (`14`) was allocated
  for a verb that judged one event and refused the others; `hook check` judges every event, so no
  verb returns it today. The row is kept rather than renumbered — the group's exit codes are a
  published contract, and reusing a retired seat is worse than leaving it empty.
- **The graded `spawn-guard guard` — PORT record in
  `claude-plugins/fabrika/docs/hook-surface.md` is marked superseded** and kept as history.
- The captured spawn envelopes in `packages/fabrika-cli/src/hook/__fixtures__/` stay. They are the
  ADR [0180](0180-capture-real-runtime-artifact-before-coding.md) record of what the harness really
  sends on a subagent launch — including that `tool_name` reads `Agent`, not `Task` — which is worth
  keeping whether or not anything acts on it.
