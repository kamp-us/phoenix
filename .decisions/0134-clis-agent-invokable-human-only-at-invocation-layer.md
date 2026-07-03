---
id: 0134
title: "CLIs are agent-invokable by default; human-only is an invocation-layer policy, not a lever TTY-refuse (supersedes [0133](0133-lever-guard-tty-confirm-on-flag-set-execute.md))"
status: accepted
date: 2026-07-03
tags: [cf-utils, release, authz, cli, security]
---

# 0134 — CLIs are agent-invokable by default; human-only lives at the invocation layer

## Context

Supersedes [0133](0133-lever-guard-tty-confirm-on-flag-set-execute.md).

ADR 0133 enforced the humans-release boundary (ADR [0083](0083-agents-deploy-humans-release.md))
at the **lever** — `cf-utils flag set --execute` hard-refuses any non-TTY caller, on the reasoning
that a TTY is a structural property an agent can't fake. In practice that stance is wrong for this
repo, on two grounds proven the day it shipped (2026-07-03):

1. **It breaks `/release` (#1729).** The `/release` skill flips a flag by calling the lever. When
   the skill is executed by the agent (the normal case — a human invokes `/release`, the agent runs
   its steps), the lever sees a non-TTY stdin and refuses. So `/release` — the very human-release
   surface 0133 meant to protect — **cannot actually flip a flag.** 0133 and #1729 shipped mutually
   incompatible.
2. **It blocks legitimate delegation.** The founder wants to say "flip this flag for me" and have
   the agent do it. 0133 makes that structurally impossible, forcing the founder to be the literal
   keystroke-typer for every flip — friction that blocks him with no benefit he wants.

The founder's principle (2026-07-03): **every CLI in this repo should be agent-invokable. Human-only
is a property of specific *invocation surfaces*, enforced there — not a structural block welded into
a tool.** He trusts the pipeline gates and the audit trail; safety that blocks him when it isn't
needed is unwanted. "I should be able to run `/release` and be done with it without thinking about
TTY or not."

## Decision

**The lever is a tool; who may release is decided at the invocation layer, backed by audit — not by
a structural refusal at the tool.**

1. **Drop the TTY hard-refuse** from `cf-utils flag set --execute`. Like every other CLI in the repo,
   the lever is agent-invokable. This reverts the structural guard of 0133 / #1781.
2. **Keep the interactive `flip <flag> live? [y/N]` confirm ONLY as human ergonomics when a TTY is
   present** — a deliberate "are you sure" before a live prod flip for someone running the lever by
   hand. A non-TTY caller (agent, CI) proceeds without a prompt, and the write is **logged**
   (a `live flip executed (non-interactive)` line) for the record.
3. **Human-only release is enforced where it belongs — the invocation surface, plus the pipeline.**
   `/release` remains the human-invoked release skill (its own human-only framing carries the ADR
   0083 boundary); an agent flip happens only on an explicit human instruction naming the flag, and
   every flip is auditable — Cloudflare's flag changelog records each write, and `/release` emits a
   release note. The boundary is **convention + audit, deliberately not structural.**

This is a conscious reversal of 0133's "make invalid states unrepresentable at the lever." It is
accepted because, for a founder who trusts his pipeline and his agents, the structural guard's
cost (a broken `/release`, no delegation) exceeds its benefit, and the audit trail makes every flip
traceable to its authorizing instruction.

## Consequences

- **`/release` works end-to-end** when the founder invokes it — the #1729/#0133 contradiction is gone.
- **Delegation works:** "flip `phoenix-mod-queue` for me" → the agent runs the lever → the flag flips →
  the write is logged and a release note is emitted. Traceable, not forbidden.
- **`flag set --execute` is now runnable by any caller, agents and CI included.** The humans-release
  boundary is no longer structural at the lever; it lives at `/release` + the audit trail. An agent
  that flips a flag *without* an explicit human instruction is a convention violation (like any other
  boundary an agent is trusted not to cross), caught by audit — not blocked by the tool.
- **#1781's guard implementation is effectively reverted** — the guard degrades to TTY-only
  ergonomics (the confirm prompt), never a refusal. `decideLeverGuard`'s non-TTY branch returns
  `Allow`, and the unit tests invert accordingly.
- The general rule this sets for the repo: **do not weld human-only into a tool via a structural
  block. Make the tool agent-invokable; gate human-only at the skill/command that fronts it.**
