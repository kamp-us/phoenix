---
id: 0198
title: Worktree-isolation identity is DERIVED from the harness sidecar and git plumbing, never inherited from the process env
status: accepted
date: 2026-07-22
tags: [pipeline, pipeline-hardening, worktree, guards, isolation]
---

# 0198 — Worktree-isolation identity is derived, never inherited

**What this decides:** the two facts every worktree-isolation consumer needs — *which worktree do I own* and *what agent-type am I* — are **derived** from the harness's per-subagent sidecar (corroborated by git plumbing), and the process env (`$WORKTREE_ROOT`, `$CLAUDE_CODE_AGENT`) is demoted to a last-resort fallback. Keying on the env is the defect, not a limitation to design around.

## Context

Investigation [#3682](https://github.com/kamp-us/phoenix/issues/3682) asked why concurrent `coder` lanes spawned with `isolation: worktree` bled edits into the shared primary checkout — and into each other's uncommitted work — despite a provisioning hook, a `PreToolUse` path guard, a `pre-bash` pin, and a fail-closed skill preflight all being in place.

The answer is not a race, not intermittent provisioning, and not a missing guard. **The worktree was provisioned correctly and the guards were disarmed by their key.**

### The evidence (observed live, in a correctly-provisioned coder worktree)

| Signal | Value | Verdict |
|---|---|---|
| `pwd` / `git rev-parse --show-toplevel` | `<main>/.claude/worktrees/agent-<id>` | worktree exists |
| `git rev-parse --absolute-git-dir` | `<main>/.git/worktrees/agent-<id>` | genuinely **linked** (≠ common dir) |
| `$WORKTREE_ROOT` | **unset** | the leak |
| `$CLAUDE_CODE_AGENT` | `crew-engineering-manager` | the **parent's** value, not `coder` |
| sidecar `agent-<id>.meta.json` | `{"agentType":"coder","worktreePath":"<the worktree>", …}` | **both facts, correct** |

Two independent, simultaneous misreports — in a lane where nothing was actually wrong.

### Why `$WORKTREE_ROOT` is empty

It is **read** by many guard modules and **written by nothing**: there is no `export WORKTREE_ROOT=` anywhere in `packages/` or `claude-plugins/`, and the `WorktreeCreate` hook cannot supply one — its only success channel is stdout-is-the-path (ADR [0178](0178-worktreecreate-hook-provisioning.md), contract grounded in a captured real payload per ADR [0180](0180-capture-real-runtime-artifact-before-coding.md)), and a hook is a subprocess whose `export` dies with it. The harness never promised the variable. The repo assumed it.

The blast radius is total, because the empty root is not a degraded signal — it is an *inert* one. `resolvePath` returns `{kind:"allow"}` the moment the root is empty, so the `PreToolUse` `Read|Edit|Write` guard — the layer positioned **before every file write**, exactly where this class must be caught — allows every path, including a primary-checkout absolute path. Reproduced against the shipped binary, same code and same path, only the env differing:

```
$WORKTREE_ROOT unset  →  {"permissionDecision":"allow"}                    ← the edit lands in the SHARED tree
$WORKTREE_ROOT set    →  {"permissionDecision":"allow", updatedInput:{…}}  ← rewritten into the worktree
$WORKTREE_ROOT set    →  {"permissionDecision":"deny",  …corrected path}   ← for a path with no worktree copy
```

That is the complete edit-bleed mechanism, and it is **deterministic, not racy**. Every `isolation: worktree` subagent is permanently in the first state.

### Why `$CLAUDE_CODE_AGENT` misreports

It carries the **parent's** value through nested spawns, so a coder spawned under the crew is indistinguishable from its engineering-manager by that signal. `isIsolationExpected` already compensates with an env-independent second disjunct (`agentType !== "" && onPrimaryCheckout`), which is the right instinct — but it still *requires* a non-empty agent-type, so the env dependency was reduced, never removed.

### The signal that was there all along

The harness writes a per-subagent sidecar next to the transcript — `<transcript-dir>/<session>/subagents/agent-<agentId>.meta.json` — carrying that agent's **own** `worktreePath` and `agentType`. The repo already trusts it: `reap` reads exactly this sidecar for its `SubagentStop` owner gate (#2798). And the hook payload names it: the `PreToolUse` envelope is built from a shared base factory that supplies `session_id`, `transcript_path`, `cwd`, `agent_id`, and `agent_type` on **every** hook event (verified against the shipped binary, not assumed).

So the authoritative identity was available on every hook call, in a file the codebase already knew how to read, while four guard modules keyed on a variable nothing sets.

## Decision

**Isolation identity is derived, in this precedence order, and the env is always last:**

1. **The per-subagent sidecar** (`worktreePath`, `agentType`) — the agent's own, authoritative, survives the cwd reset and the env inheritance.
2. **Git plumbing** — `git rev-parse --show-toplevel`, trusted **only** when `--absolute-git-dir ≠ --git-common-dir` proves a linked worktree. On the primary checkout the toplevel is the shared tree, which must never be reported as an isolated agent's root.
3. **The process env** — `$WORKTREE_ROOT` / `$CLAUDE_CODE_AGENT`, last resort only.
4. **Nothing** — resolve to `""`, never invent a target.

This lands as `packages/pipeline-cli/src/tools/worktree-guard/isolation-identity.ts`: a pure, IO-free, unit-tested core (the caller does the sidecar read and the git probes). A probe that cannot run is **"unknown"** — never read as positive evidence in either direction.

**Scope boundary, held deliberately.** This ADR decides the **detector**, not the **policy**. The resolved identity is wired into the record-only attribution path and **not** into any permission decision. Whether a guard should *refuse* on a proven-unsafe state is the open fail-open-vs-fail-closed fork in [#3743](https://github.com/kamp-us/phoenix/issues/3743) — which presupposes exactly this detector ("Detection is a separate concern: fixing it does not answer the fail-open-vs-closed question") and requires an adversarial threat-model of the shared-`.git/hooks` stall before any horn is implemented. That ruling is not taken here.

## Consequences

- **The forensic trail stops lying.** The `pre-bash` attribution log exists to attribute cross-lane contamination to a lane, and it recorded every isolated coder as its parent, rootless — blind in precisely the incidents it was built to explain. It now records the derived identity plus each field's provenance.
- **A new binding rule for future work on these guards.** Any consumer needing "my worktree" or "my agent-type" calls `resolveIsolationIdentity`. Promoting the env back above the sidecar re-introduces this defect; the precedence order is the invariant, and the unit tests pin it.
- **The guard-timing gap is characterized, and it is not a timing bug.** A raw `Edit`/`Write` is not a git op, so no `wt_preflight` or repo-side git guard fires on it — but the `PreToolUse` `Read|Edit|Write` hook already sits ahead of every file write. The correctly-positioned layer exists; it was disarmed, not mistimed. Re-keying it is what closes the window — but *arming* it changes what the guard refuses, so it is sequenced behind #3743.
- **The agent-type misreport is fixable without the harness** — by not depending on the inherited variable. Both the payload's `agent_type` and the sidecar's `agentType` carry the agent's own value.
- **This does not make concurrent lanes safe on its own.** Two other layers are independently down: worktree provisioning can silently no-op ([#3744](https://github.com/kamp-us/phoenix/issues/3744)), and the deployed guard binary is stale because the pinned `@kampus/pipeline-cli` version was never published, while the readiness check tests executability rather than version ([#3742](https://github.com/kamp-us/phoenix/issues/3742)) — so no source change here takes effect until that publish lands. Until all three are closed, **treat concurrent coder lanes as unsafe**: the write-code Step-4 preflight (ADR [0172](0172-write-code-fails-loud-when-expected-worktree-isolation-is-absent.md)) remains the surviving layer, and it is an agent-discipline check, not an enforced one.
- **`$WORKTREE_ROOT` is not deleted.** It stays as a corroborator so an environment that *does* inject it keeps working — it simply stops being the key.
