---
id: 0172
title: write-code fails closed LOUD when worktree isolation was expected but the harness didn't provision it — self-provision is standalone-only
status: accepted
date: 2026-07-11
tags: [pipeline, worktree, harness, safety, gates]
---

# 0172 — write-code fails closed LOUD when expected worktree isolation is absent

## Context

The defense against primary-checkout corruption (a coder run mutating the shared primary
checkout's git state — the [#2270](https://github.com/kamp-us/phoenix/issues/2270) class) is
meant to be **two layers**:

1. The harness provisions a linked git worktree for an `isolation:worktree` coder spawn and
   injects `$WORKTREE_ROOT` (the contract in `.patterns/worktree-agent-constraints.md`).
2. `write-code`'s Step-4 preflight backstops it (`git-dir == common-dir` ⇒ primary checkout ⇒
   refuse), and a **Non-isolated fallback** self-provisions a worktree from a primary-checkout
   start.

Investigation [#2440](https://github.com/kamp-us/phoenix/issues/2440) (root cause resolved)
established that the **harness layer silently no-ops** for coder spawns nested under the crew
Workflow — an out-of-repo harness condition, not a repo bug. When it no-ops, two things happen
at once:

- The entire repo-side `worktree-guard` suite disarms: every subcommand keys on `$WORKTREE_ROOT`
  (`packages/pipeline-cli/src/tools/worktree-guard/command.ts`), so an unset root makes
  path-pinning, cwd-pinning, and the bare-git refusal all clean no-ops.
- The **only** surviving defense is `write-code`'s Step-4 preflight plus its Non-isolated
  fallback — but that fallback **self-provisions silently in *both* the expected-isolation-failure
  case and a legitimate standalone run**, because Step-4 consulted only `git-dir`/`common-dir`,
  never whether isolation was *expected*.

So a harness no-op collapsed the two-layer guarantee to one, *and did so invisibly*: the operator
never learned provisioning was broken, and the underlying harness bug stayed hidden behind a
self-provision that "just worked."

## Decision

`write-code` Step-4 now **distinguishes an expected-isolation failure from a genuine standalone
run**, and forks the primary-checkout refusal accordingly:

- **Isolation was EXPECTED** and the run is on the primary checkout with `$WORKTREE_ROOT` unset
  ⇒ **fail closed LOUD and stop.** Emit a ROUTED BLOCKER surfacing the harness provisioning
  failure up to the operator/EM. **Do not self-provision** — that would paper over the harness
  no-op and leave the two-layer defense collapsed to one, invisibly.
- **Isolation was NOT expected** (a standalone `write-code`, e.g. a human `/write-code`) ⇒ the
  Non-isolated self-provision fallback stays, unchanged. The loud branch never fires here, so the
  standalone path does not regress.

The **"isolation expected" signal is machine-checkable and grounded in the coder agent-type's
unconditional-isolation assertion** (`claude-plugins/kampus-pipeline/agents/coder.md`), read from
the harness-set `$CLAUDE_CODE_AGENT` env (the agent-type name — stable across an agent's separate
Bash calls, unlike a shell `export`), corroborated by a set `$WORKTREE_ROOT`. It is *not* a
per-run guess.

### Why the skill-internal signal, not a `.claude/workflows/drive-issue.js` spawn-env marker

The mechanism is deliberately internal to the `write-code` skill + `coder.md` agent surface: it
reads the already-existing `$CLAUDE_CODE_AGENT` signal rather than injecting a new env var at the
`drive-issue.js` spawn site. This keeps the §CP spawn-orchestrator untouched and avoids a new
spawn-to-skill contract. `coder.md` is itself §CP (control-plane owned), so the agent-type
assertion the signal rests on is governed; the signal consumes it, it does not re-declare it.

## Consequences

- **The harness failure becomes observable and routed** instead of silently absorbed. The
  out-of-repo harness half (why provisioning no-ops for a Workflow-nested spawn) can be fixed
  because the operator now learns it happened, rather than the fallback masking it.
- **The additive branch fails safe.** If the `$CLAUDE_CODE_AGENT` value ever differs from what the
  match expects, the run degrades to `isolation-expected=0` — today's silent self-provision — never
  to a dangerous primary-checkout mutation. The loud branch only *adds* a stop; the pre-existing
  `git-dir == common-dir` refusal is preserved intact.
- **The standalone path is unchanged.** A human running `write-code` directly still self-provisions
  via the Non-isolated fallback.
- **Scope note (§CP):** this decision changes `agents/coder.md` (control-plane owned) alongside the
  non-§CP `skills/write-code/SKILL.md`, so the PR is §CP and merges by a human control-plane owner.
  It does **not** touch `.claude/workflows/drive-issue.js`.
