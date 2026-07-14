---
id: 0181
title: Unified intake dedup — one deterministic `pipeline-cli` tool wired at two seams (report + triage), not a GitHub Action
status: accepted
date: 2026-07-13
tags: [pipeline, intake, triage]
---

# 0181 — Unified intake dedup — one deterministic tool at two seams

## Context

Two intake paths create issues, and only one of them dedups. The **agent path**
(the [`report`](../.claude/skills/report/SKILL.md) skill) already runs a pre-file
"is there already an open issue for this?" check before it files. The **human path**
— an issue filed directly through the GitHub UI — runs no such check, so a
human-filed duplicate (e.g. #2802) lands unguarded and only gets caught, if at all,
by someone noticing. The dedup logic that does exist lives inline in the report
skill, so even the agent-path check is prose an agent re-derives each time rather
than one tested implementation.

The intake-hygiene question was: where do we enforce dedup so **both** paths are
covered without introducing drift between two copies of the "same open issue?"
heuristic? Three candidates were on the table:

- **(a)** a server-side `issues.opened` GitHub Action that runs on every issue open;
- **(b)** a new triage-time intake check in the triage skill (human path);
- **(c)** extracting the dedup query into a `pipeline-cli` tool (one deterministic
  implementation).

This is the human-path prong (resolves #2990) of the intake-hygiene trio — sibling to
#2987 (creation-side) and #2988 (cleanup-side).

## Decision

Unify agent-path and human-path intake dedup on **one deterministic implementation** —
candidate **(c)+(b)**, not the GitHub Action (a).

- **Extract the dedup query into a `pipeline-cli` dedup tool.** The "is there already
  an open issue for this?" check becomes one tested, deterministic `pipeline-cli`
  command — the CLI-first = determinism convention. There is a single source of truth
  for the heuristic; nothing re-derives it in prose.
- **Invoke that same tool at two seams:**
  1. the report skill's existing pre-file check (**agent path** — already there;
     re-point it at the tool instead of inline prose);
  2. a **new** triage-time intake check in the triage skill (**human path**). Triage
     already board-reads every intake issue, so this is the zero-new-surface
     enforcement point — it catches UI-filed issues like #2802 without adding any new
     always-on machinery.
- **Rejected — (a) the `issues.opened` GitHub Action.** It is the heaviest surface: a
  new server-side automation firing on *every* issue open, duplicating exactly the
  board-read triage already performs on every intake issue. It buys nothing over
  wiring the tool into triage, at strictly higher operational surface.

The **why**: one deterministic tool means no drift between the two intake paths — both
seams call the identical, tested implementation. The two invocation seams cover both
the agent path (report) and the human path (triage board-read) with **zero new
surface**. The Action was rejected as redundant with triage and the heaviest of the
three options.

This ADR is a **new** decision record — it does not amend or supersede an existing
ADR. It is conversation-authored per ADR
[0075](0075-issueless-doc-pr-merge-seam.md) (founder-decided, exempt from triage).

## Consequences

- The dedup heuristic has one home (`pipeline-cli`) and one test surface; the report
  skill and the triage skill both consume it rather than each carrying their own copy.
- The **human path is now covered** — a UI-filed duplicate is caught at triage's
  existing board-read, closing the #2802 gap, without standing up a server-side
  automation.
- No `issues.opened` GitHub Action is added; the intake surface does not grow.
- **The implementation is a separate bounded §CP follow-up** (the `pipeline-cli` dedup
  tool + the two skill wirings), filed separately. This ADR records the decision only;
  it ships no code.
