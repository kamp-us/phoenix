---
id: 0129
title: ADR discovery is the CLAUDE.md contract alone — drop the SessionStart-hook indirection (supersedes 0126 §Decision 3)
status: amended-in-part by [0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md)
date: 2026-07-03
tags: [decisions, pipeline, docs, autonomy]
---

# 0129 — ADR discovery is the CLAUDE.md contract alone; drop the SessionStart-hook indirection

## Context

[ADR 0126](0126-ambient-adr-discovery.md) deleted the committed `.decisions/index.md` and
made discovery **ambient** three ways: filenames + frontmatter are the row (§Decisions 1/2),
a PR-side `validate` job stays as the number-lock backstop (§Decision 4), a repo
`SessionStart` hook injects a compact `id · title · status` map into every session
(§Decision 3), and a fallback for hook-less contexts — `ls .decisions/` + frontmatter —
covers subagents that don't inherit session context (§Decision 5).

The `SessionStart` map-injection hook (§Decision 3) is now dropped **before it was built**.
The founder's call (2026-07-03): *"it's just an indirection; ADR discovery should be only
part of the CLAUDE.md contract."* The hook buys nothing the CLAUDE.md contract doesn't
already state — `ls .decisions/` reads the `NNNN-slug` map, each file's frontmatter is the
row, and `pipeline-cli decisions-index compact` renders the full `id · title · status` map
**on demand** (landed #1718) for anyone who wants it in one line each. Auto-injecting that
same map into every session is indirection: a hook to maintain, a per-session token cost
0126 §Consequences already flagged, and a second discovery path to keep honest against the
CLAUDE.md contract — for a map the reader can produce in one command. The §Decision 5
fallback was already the mechanism every subagent used; there is no reason for the
session-context path to differ from it.

This is a conversation-authored decision (ADR 0075) — founder-stated, no implementing
issue behind the *choice*; #1728 carries the doc changes.

## Decision

**ADR discovery is the CLAUDE.md contract alone — there is no `SessionStart` ADR-map hook.**

1. **Drop §Decision 3 of ADR 0126 (the `SessionStart` map-injection hook).** No repo
   `SessionStart` hook injects the compact ADR map into session context; none is added to
   `.claude/settings.json`. The hook is dropped as needless indirection, not deferred.

2. **Promote ADR 0126 §Decision 5 (the fallback) to the sole discovery mechanism.**
   Discovery is what the CLAUDE.md contract states, uniformly across every context
   (session, subagent, CI):
   - `ls .decisions/` — the `NNNN-slug` filenames are the map;
   - each file's frontmatter (`id`/`title`/`status`) is the row;
   - `pipeline-cli decisions-index compact` renders the full `id · title · status` map
     **on demand** (never auto-injected).

3. **Retain ADR 0126 §Decisions 1, 2, and 4 unchanged.** The committed `index.md` stays
   deleted and is never committed again (§1); frontmatter + `NNNN-slug` filenames remain the
   row and map (§2); the PR-side `validate` number-lock backstop stays (§4, the ADR 0074
   number-lock). This ADR reverses **only** §Decision 3.

## Consequences

- **ADR 0126 stays `status: accepted`, its body unedited.** Only its §Decision 3 is reversed;
  §Decisions 1/2/4/5 stand, so a wholesale `superseded` flip would misstate the record. ADRs
  are immutable once accepted — 0126 is referenced from here, not rewritten (ADR 0075 §append,
  not edit).
- **One discovery contract, no divergence.** With no injected map, the session and subagent
  paths are identical — the drift risk of keeping two discovery mechanisms honest against each
  other is gone. There is nothing to maintain and nothing to inject; the per-session token
  cost 0126 flagged is not paid.
- **On-demand, not ambient.** A reader who wants the full one-line-per-ADR map runs
  `pipeline-cli decisions-index compact` explicitly. The map is never surfaced automatically;
  the cost is one command when you want the rendered list, versus scanning `ls` + frontmatter.
- **CLAUDE.md `## Decisions` is the single statement of the contract.** It drops the
  `SessionStart`-hook language and states the `ls` + frontmatter + on-demand-`compact` contract,
  pointing here for the why (#1728).

> Amendment 2026-08-19: the decision stands — discovery is the CLAUDE.md contract (`ls .decisions/` + each file's frontmatter), never an injected map. Only the on-demand renderer moved: `packages/pipeline-cli` is retired, and `fabrika-cli` ports only the number lock (`fabrika guard decisions-index validate`) — there is no `compact` verb today, so `ls .decisions/` + frontmatter is the whole map until one is re-added. CLAUDE.md `## Decisions` needs the same fix.
