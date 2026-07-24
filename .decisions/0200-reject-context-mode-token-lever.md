---
id: 0200
title: Reject `mksglu/context-mode` as a token-economics lever (current evidence)
status: accepted
date: 2026-07-23
tags: [pipeline, pipeline-hardening, token-economics]
---

# 0200 — Reject context-mode as a token-economics lever (current evidence)

**What this decides:** we evaluated the external `mksglu/context-mode` MCP+hooks plugin as a
candidate token-saving lever for the pipeline and are **not adopting it, on current evidence** —
it optimizes a cost axis that isn't our dominant spend, and adopting it would collide with three
more of our design constraints besides.

## Context

Evaluated as a candidate token-saving lever for the token-economics epic
([#1356](https://github.com/kamp-us/phoenix/issues/1356)), against the baseline
[measurement apparatus](../reports/token-economics-measurement.md) and its sibling
[audit](../reports/token-economics-audit.md).

The tool evaluated is [`mksglu/context-mode`](https://github.com/mksglu/context-mode) — "Context
window optimization for AI coding agents. Sandboxes tool output (98% reduction), persists session
memory, and enforces routing across 17 platforms via MCP + hooks" (its repo description, read
2026-06-27 at the `main` head).

context-mode is an **MCP server + lifecycle-hook plugin**. On Claude Code it installs via the
plugin marketplace (`/plugin marketplace add mksglu/context-mode` → `/plugin install`), registering
six lifecycle hooks (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, SessionStart, Stop) and
**11 MCP tools** — six sandbox tools (`ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`,
`ctx_index`, `ctx_search`, `ctx_fetch_and_index`) plus five meta-tools (`ctx_stats`, `ctx_doctor`,
`ctx_upgrade`, `ctx_purge`, `ctx_insight`). Its README states it attacks four cost centers: (1)
**context saving** (the headline 98% figure) — sandbox tools keep raw tool output (large
`Read`/`Bash`/`WebFetch` results) out of the context window; (2) **session continuity** — file
edits / git ops / tasks / errors tracked in SQLite, indexed into FTS5 on compaction and retrieved
via BM25, explicitly tied to a **continued session** (`--continue`; "a fresh session means a clean
slate"); (3) **"think in code"** — a routing paradigm nudging the model to write a script that
computes the answer and log only the result (`ctx_execute`) instead of reading many files into
context; (4) it deliberately does **not** touch how the model writes its final prose. License:
**Elastic License v2 (ELv2)**, not OSI-open; it also ships a hosted analytics surface
(`ctx_insight` → `context-mode.com/insight`).

context-mode is technically installable for our Claude Code + skills + subagent-fan-out pipeline
— it would wrap the tool layer (intercepting `Bash`/`Read`/`WebFetch`) without replacing any skill,
adding the 11 `ctx_*` tools to the toolset. Four fit frictions argue against adopting it anyway.

## Decision

**Reject `mksglu/context-mode` as a token-saving lever, on current evidence.**

**1. Cost-axis mismatch — it optimizes a surface that is not our dominant bloat (decisive).**
The [audit](../reports/token-economics-audit.md) reconstructed, from actual `claude-opus-4-8`
frozen-set sub-agent transcripts, where our pipeline tokens go:

| Stage | billed | cache_read % | scaffolding cache_read (% of billed) | task-tail cache_read |
|---|---:|---:|---:|---:|
| triage (#1227) | 592,499 | 70% | 355,135 (**60%**) | 61,939 |
| write-code (#1223) | 2,076,940 | 93% | 1,129,030 (**54%**) | 796,095 |
| review-code (#1199) | 1,325,645 | 86% | 574,380 (**43%**) | 569,843 |

The audit's headline: **43–60% of every stage's total spend is `cache_read` re-reading a fixed
scaffolding floor** — the harness system prompt + tool schemas + injected `CLAUDE.md` + the loaded
`SKILL.md` — on every turn. That floor is resident context, re-charged each turn; the one-time
ingest is small and the **turn-count multiplier** is the cost.

context-mode's headline lever (sandbox tools, "think in code", the 98% figure) reduces raw tool
output entering context — it can only act on the **task-tail** column, and only on the raw-read
sub-portion of it, never on the reasoning. It **cannot touch the resident-scaffolding floor at
all**: the `SKILL.md`/`CLAUDE.md`/tool-schema prefix is not re-fetched through an interceptable
tool each turn — it is already resident in the context window, and context-mode prevents data from
*entering*, it does not evict already-resident context mid-conversation. Even at its theoretical
best it leaves the 43–60% the audit named Rank 1 untouched, and it is plausibly **net-negative on
short stages**: it adds 11 MCP tool schemas to the resident prefix, re-charged every turn per the
audit's Rank 1 / Rank 4 finding, which on a short, low-tool-output stage (e.g. triage, ~10%
task-tail) can exceed the small task-tail read it could sandbox.

Our own Rank-1 lever already targets exactly the dominant cost, in-repo and license-free: split
each skill into a thin resident procedural core + lazily-`Read` reference contracts, and trim the
injected `CLAUDE.md` footprint. Adopting an external ELv2 host dependency to attack a *secondary*
axis, while our own better-targeted lever attacks the *primary* one, is not justified.

**2. Host/session-level install collides with repo-as-config.** context-mode installs into the
Claude Code **host** (`/plugin install`, plus the operator's user settings for the statusline), not
as a repo-committed artifact. Our pipeline is deliberately repo-as-config
([ADR 0062](0062-repo-as-config-plugin.md)): the operable surface lives in the repo
(`claude-plugins/kampus-pipeline/**`, `.claude/**`) so a checkout *is* the configuration. A
fleet-wide context-mode dependency is a host-level change applied to every operator/runner out of
band — it cannot land or be validated by a normal repo PR, and it is invisible to a fresh checkout.

**3. Stateless one-shot subagents vs context-mode's continued-session model.** context-mode's
session-continuity pillar assumes a long-lived, `--continue`d session whose SQLite/FTS5 event log
is the point. Our pipeline is the opposite by design: every stage is a **one-shot
`isolation:worktree` subagent** that re-derives state fresh each run (see
[worktree-agent-constraints.md](../.patterns/worktree-agent-constraints.md)). For one-shot spawns
that never `--continue`, the session-continuity pillar is inert — and whether context-mode's
hooks/MCP/SQLite even propagate correctly into harness-spawned worktree subagents is unverified and
a real integration risk, not a given.

**4. License + hosted dependency.** ELv2 is not OSI-open, and `ctx_insight` points at a hosted
dashboard. A fleet-wide build-pipeline dependency on a non-open external tool + hosted service is a
governance consideration that should be a deliberate decision, not a silent adopt.

**The measured token + quality delta was not obtainable in this evaluation lane — stated, not
fabricated.** The apparatus demands a measured before/after on a representative frozen-set task
(a real `cost.total_tokens` number) and the quality rubric to be run; per the epic's
no-fabrication discipline, no number is invented here. Enabling context-mode requires a host-level
`/plugin install` + restart, which a worktree doc-subagent has neither the host plugin surface nor
the authority to perform (also a no-local-paths / self-mod boundary); a real before/after also
means spawning instrumented stage subagents with and without context-mode, which this lane has no
agent-spawn tool to do; the quality rubric in turn requires those runs to exist. A token saving
that cannot be measured is not an adopt, and a token saving that fails the quality gate is a
reject — and here the quality gate could not even be reached. Combined with the fit analysis, the
honest call is reject on current evidence, with the measured A/B explicitly flagged as the missing
input rather than estimated.

## Consequences

**This is not a permanent ban — it is a reject-on-current-evidence, with a stated reopen path.**
A future, host-level measurement run outside a doc-lane could flip this verdict if it demonstrates
context-mode is net-positive despite the cost-axis mismatch:

1. On the Claude Code host, install context-mode and confirm via `/context-mode:ctx-doctor`.
2. Run a frozen-set stage (start with write-code #1223 or review-code #1199 — the two stages whose
   task-tail `cache_read` is largest, ~38–43% of billed, so most exposed to sandbox-tool savings)
   twice on the same input — once without, once with context-mode — capturing each run's
   `cost.total_tokens` per the apparatus.
3. Report the **net** delta: the task-tail read reduction minus the added resident-cost of the 11
   `ctx_*` tool schemas re-charged across every turn. A genuine adopt requires the net to be a real
   saving on the stage *and* the quality rubric to return quality-preserved (same
   classification/verdict, no lost AC).
4. Verify context-mode's hooks/MCP actually propagate into a harness-spawned `isolation:worktree`
   subagent (fit friction 3) — a measured saving on an interactive session does not transfer if the
   plugin is inert in our fan-out spawns.

If that run shows a net saving with quality preserved, this reopens as adopt-with-caveats (caveats
2–4 above remain). Absent it, the in-repo Rank-1 skill-split lever is the better-targeted fix for
our measured dominant cost, and no external dependency, host-level install, or hosted-service
governance question needs to be taken on.

## Records

- Converts `.patterns/token-economics-context-mode-eval.md` (removed by this PR — an adopt/reject
  decision record with a *why* belongs in `.decisions/`, not `.patterns/`, which is code-shape)
  into this ADR. Content-preserving conversion; the verdict and reasoning are unchanged from the
  source document.
- Closes [#3467](https://github.com/kamp-us/phoenix/issues/3467). Sibling
  [#3394](https://github.com/kamp-us/phoenix/issues/3394) is the mechanical relocation of the two
  `reports/` measurement docs — a separate lane, untouched by this ADR.
- No vocabulary impact — this ADR re-decides a prior evaluation's home, coining no new term and
  redefining none.
