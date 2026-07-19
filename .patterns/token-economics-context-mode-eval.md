# Token-economics lever eval — context-mode

**Verdict: reject (on current evidence).** Evaluated as a candidate token-saving lever for
the token-economics epic ([#1356](https://github.com/kamp-us/phoenix/issues/1356)), against the
baseline [measurement apparatus](../reports/token-economics-measurement.md) and its sibling
[audit](../reports/token-economics-audit.md). The reject rests on a **fit argument grounded in our own
measured spend profile**, plus an honest statement that the apparatus's **measured
before/after could not be produced in this evaluation lane** — and a deliberate refusal to
fabricate one. See [What would flip this verdict](#what-would-flip-this-verdict) for the exact
measurement that would reopen it.

The tool evaluated is [`mksglu/context-mode`](https://github.com/mksglu/context-mode) — "Context
window optimization for AI coding agents. Sandboxes tool output (98% reduction), persists session
memory, and enforces routing across 17 platforms via MCP + hooks" (its repo description, read
2026-06-27 at the `main` head).

## What context-mode is (grounded in its repo)

context-mode is an **MCP server + lifecycle-hook plugin**. On Claude Code it installs via the
plugin marketplace (`/plugin marketplace add mksglu/context-mode` → `/plugin install`), registering
six lifecycle hooks (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, SessionStart, Stop) and
**11 MCP tools** — six sandbox tools (`ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`,
`ctx_index`, `ctx_search`, `ctx_fetch_and_index`) plus five meta-tools (`ctx_stats`, `ctx_doctor`,
`ctx_upgrade`, `ctx_purge`, `ctx_insight`). (Source: its README "Install → Claude Code" section.)

Its README states it attacks four cost centers:

1. **Context saving (the headline 98%)** — *sandbox tools keep raw tool output out of the context
   window.* The cited wins are large tool-output dumps: "A Playwright snapshot costs 56 KB. Twenty
   GitHub issues cost 59 KB. One access log — 45 KB … 315 KB becomes 5.4 KB." The mechanism is
   PreToolUse interception that routes a would-be large `Read`/`Bash`/`WebFetch` result through a
   sandbox so only a small summary enters context.
2. **Session continuity** — every file edit / git op / task / error is tracked in SQLite; on
   compaction it indexes events into FTS5 and retrieves only relevant slices via BM25 (rather than
   dumping them back into context). Explicitly tied to a **continued session** (`--continue`); "a
   fresh session means a clean slate" and previous-session data is deleted.
3. **"Think in code"** — a routing paradigm nudging the model to *write a script that computes the
   answer and `console.log()`s only the result* (`ctx_execute`) instead of reading many files into
   context. "Before: 47 × Read() = 700 KB. After: 1 × ctx_execute() = 3.6 KB."
4. **No prose-style enforcement** — it deliberately does *not* touch how the model writes its final
   answer (a stance it defends by citing brevity-prompt benchmark regressions).

License: **Elastic License v2 (ELv2)** per its README badge — not an OSI-open license. It also ships
a hosted analytics surface (`ctx_insight` → `context-mode.com/insight`).

## Fit analysis — does it integrate with our Claude Code + skills + subagent-fan-out pipeline?

**Technically installable: yes.** context-mode is built first-class for Claude Code (it is the lead
platform in its README), so "can it be installed at all" is not the blocker — the integration *shape*
is well defined: a host/session-level Claude Code plugin (MCP server + the six hooks), optionally a
statusline edit to the operator's Claude Code user settings. It would **wrap** our tool layer (intercepting
`Bash`/`Read`/`WebFetch`), not replace any of our skills, and would **add** the 11 `ctx_*` tools to
the toolset. But four fit frictions, the first decisive, argue against adopting it for *our* setup:

### 1. Cost-axis mismatch — it optimizes a surface that is not our dominant bloat (decisive)

This is the core of the reject, and it is grounded in our own measured numbers, not intuition. The
[audit](../reports/token-economics-audit.md) reconstructed, from the actual `claude-opus-4-8` frozen-set
sub-agent transcripts, *where* our pipeline tokens go:

| Stage | billed | cache_read % | scaffolding cache_read (% of billed) | task-tail cache_read |
|---|---:|---:|---:|---:|
| triage (#1227) | 592,499 | 70% | 355,135 (**60%**) | 61,939 |
| write-code (#1223) | 2,076,940 | 93% | 1,129,030 (**54%**) | 796,095 |
| review-code (#1199) | 1,325,645 | 86% | 574,380 (**43%**) | 569,843 |

The audit's headline: **43–60% of every stage's total spend is `cache_read` re-reading a fixed
scaffolding floor — the harness system prompt + tool schemas + injected `CLAUDE.md` + the loaded
`SKILL.md` — on every turn.** That floor is resident context, re-charged each turn; the one-time
ingest is small and the **turn-count multiplier** is the cost.

context-mode's headline lever (sandbox tools, "think in code", the 98% figure) reduces **raw tool
output entering context** — i.e. it can only act on the **task-tail** column, and only on the raw-read
sub-portion of it (the `gh api …/comments` JSON dumps, large `Read`s), never on the reasoning. It
**cannot touch the resident-scaffolding floor at all**: the `SKILL.md` / `CLAUDE.md` / tool-schema
prefix is not re-fetched through an interceptable tool each turn — it is already resident in the
context window, and context-mode prevents data from *entering*, it does not evict already-resident
context mid-conversation. So even at its theoretical best, context-mode leaves the 43–60% that the
audit named **Rank 1** untouched.

Worse, it is plausibly **net-negative on short stages**. context-mode *adds* 11 MCP tool schemas to
the resident prefix — and the audit's **Rank 1 / Rank 4** finding is that resident-prefix size is
re-charged every turn and re-paid by every agent in a fan-out. On a short, low-tool-output stage like
triage (19 turns, task-tail only ~10% of billed), the added tool-schema overhead re-read across every
turn can exceed the small task-tail read it could sandbox. This is a falsifiable prediction the §2
procedure would measure.

And our **Rank-1 lever already targets exactly the dominant cost**, in-repo and license-free: split
each skill into a thin resident procedural core + lazily-`Read` reference contracts, and trim the
injected `CLAUDE.md` footprint (audit Rank 1). Adopting an external ELv2 host dependency to attack a
*secondary* axis, while our own better-targeted lever attacks the *primary* one, is not justified.

### 2. Host/session-level install collides with repo-as-config (ADR 0062)

context-mode installs into the Claude Code **host** (`/plugin install`, plus the operator's
Claude Code user settings for the statusline), not as a repo-committed artifact. Our pipeline is deliberately **repo-as-config** (ADR
[0062](../.decisions/0062-repo-as-config-plugin.md)): the operable surface lives in the repo
(`claude-plugins/kampus-pipeline/**`, `.claude/**`) so a checkout *is* the configuration. A
fleet-wide context-mode dependency is a host-level change applied to every operator/runner out of
band — it cannot land or be validated by a normal repo PR, and it is invisible to a fresh checkout.

### 3. Stateless one-shot subagents vs context-mode's continued-session model (assumption violation)

context-mode's **session-continuity** pillar assumes a **long-lived, `--continue`d** session whose
SQLite/FTS5 event log is the point ("a fresh session means a clean slate … previous session data is
deleted"). Our pipeline is the opposite by design: every stage is a **one-shot `isolation:worktree`
subagent** that **re-derives state fresh** each run (the write-code skill's "the loop is stateless and
always does the right next thing"; the subagents-don't-inherit-skills and cwd-reset-between-calls
harness facts in [`worktree-agent-constraints.md`](./worktree-agent-constraints.md)). For one-shot
spawns that never `--continue`, the session-continuity pillar is inert — and whether context-mode's
hooks/MCP/SQLite even propagate correctly into harness-spawned worktree subagents is **unverified**
and a real integration risk, not a given.

### 4. License + hosted dependency (governance)

ELv2 is not OSI-open, and `ctx_insight` points at a hosted dashboard (`context-mode.com`). A
fleet-wide build-pipeline dependency on a non-open external tool + hosted service is a governance
consideration that should be a deliberate decision, not a silent adopt.

## Measured token + quality delta — not obtainable in this lane (stated, not fabricated)

The apparatus §2 demands a **measured** before/after on a representative frozen-set task (a real
`cost.total_tokens` number, not an estimate), and §3 demands the quality rubric be **run**. **Neither
was obtainable in this evaluation lane, and per the epic's no-fabrication discipline no number is
invented here.** The concrete reasons:

- **Install is host-level and restart-gated.** Enabling context-mode requires `/plugin install` (or an
  edit to the operator's Claude Code user settings) on the Claude Code host followed by a
  restart/`/reload-plugins`. It cannot take effect mid-session, and a worktree doc-subagent has
  neither the host plugin surface nor the authority to edit the operator's user-level Claude config
  (also a no-local-paths / self-mod boundary).
- **The §2 procedure requires spawning instrumented stage subagents.** A real before/after means
  running the frozen-set stage agent (triage #1227 / write-code #1223 / review-code #1199) **with and
  without** context-mode and capturing each run's `cost.total_tokens`. This lane has no agent-spawn
  tool and cannot reconfigure the host plugin set between two runs, so the matched A/B cannot be
  executed here.
- **The quality rubric (§3) cannot run without those runs.** Its oracles (same classification / same
  verdict / `Fixes #N` + green CI + `review-code: PASS`) require the instrumented runs above to exist.

A token saving that cannot be measured is not an adopt, and a token saving that fails the quality gate
is a reject — and here the quality gate could not even be reached. Combined with the fit analysis, the
honest call is **reject on current evidence**, with the measured A/B explicitly flagged as the missing
input rather than estimated.

## What would flip this verdict

A future, host-level measurement run — outside this doc-lane — that demonstrates context-mode is
**net-positive** despite the cost-axis mismatch:

1. On the Claude Code host, install context-mode (`/plugin install context-mode@context-mode`) and
   confirm via `/context-mode:ctx-doctor`.
2. Run a frozen-set stage (start with **write-code #1223** or **review-code #1199** — the two stages
   whose task-tail `cache_read` is largest, ~38–43% of billed, so most exposed to sandbox-tool
   savings) twice on the **same** input — once without, once with context-mode — capturing each run's
   `cost.total_tokens` per the apparatus §2 (live statusLine or the offline four-component
   reconstruction).
3. Report the **net** delta: the task-tail read reduction **minus** the added resident-cost of the 11
   `ctx_*` tool schemas re-charged across every turn (the audit's Rank-1/Rank-4 multiplier). A genuine
   adopt requires the net to be a real saving on the stage *and* the §3 rubric to return
   quality-preserved (same classification/verdict, no lost AC).
4. Verify context-mode's hooks/MCP actually propagate into a harness-spawned `isolation:worktree`
   subagent (fit friction 3) — a measured saving on an interactive session does not transfer if the
   plugin is inert in our fan-out spawns.

If that run shows a net saving with quality preserved, this reopens as **adopt-with-caveats** (caveats
2–4 above remain). Absent it, the in-repo Rank-1 skill-split lever is the better-targeted fix for our
measured dominant cost.

## Provenance

- context-mode claims grounded in [`mksglu/context-mode`](https://github.com/mksglu/context-mode)
  README + repo metadata (read 2026-06-27, `main` head): the Install/Claude Code section (hooks +
  11 MCP tools), the "How Context Mode Solves It" four-pillar section, the ELv2 license badge.
- our-side claims grounded in [`token-economics-measurement.md`](../reports/token-economics-measurement.md)
  (apparatus §1–§3) and [`token-economics-audit.md`](../reports/token-economics-audit.md) (the measured
  scaffolding-vs-task-tail breakdown, Rank 1 / Rank 4), and ADR
  [0062](../.decisions/0062-repo-as-config-plugin.md) (repo-as-config).
- part of epic [#1356](https://github.com/kamp-us/phoenix/issues/1356); uses the
  [#1370](https://github.com/kamp-us/phoenix/issues/1370) apparatus.
</content>
