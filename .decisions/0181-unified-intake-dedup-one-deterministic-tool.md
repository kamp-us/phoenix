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
(the `report` skill) already runs a pre-file
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

> Amendment 2026-08-19: the dedup tool shipped as `fabrika report dedup` in `packages/fabrika-cli/src/report/dedup.ts` (+ `dedup-verb.ts`), not `pipeline-cli`; both seams call it — the report skill (claude-plugins/fabrika/skills/report/SKILL.md) and the triage skill's intake check (claude-plugins/fabrika/skills/triage/SKILL.md, with `--exclude`). See ADR 0303.

> Amendment 2026-08-21: one triage wave on 2026-08-18 closed 8 of 13 issues as duplicates or already-fixed (#6070), and the founder ruled on that evidence — [comment 5361950454](https://github.com/kamp-us/phoenix/issues/6070#issuecomment-5361950454), verbatim answer `a+c`. Four things follow, and nothing else does.
>
> **(a) accepted — dedup's search half widens to closed issues.** `fabrika report dedup` moves from `searchOpenIssues` to the open-plus-closed `searchIssues` that already sits beside it in `packages/fabrika-cli/src/io/issues.ts`. The ruling bounds that search to a recent window so this ADR's noise concern stays contained, but names no value for it, and neither helper carries a window parameter today — **the concrete bound is unset and this amendment does not set one**, because a number nobody ruled is not a decision. Picking it is the first thing #6923 has to settle.
>
> **Dedup stays advisory, never a gate.** Filing never stalls: `candidates`, `none` and `indeterminate` all keep exiting 0 in `packages/fabrika-cli/src/report/dedup-verb.ts`, and nothing on the filing path may stop a filing.
>
> **(b) rejected — no tree-freshness check.** Nothing on the report path compares the working tree to `origin/main`, and that includes `packages/fabrika-cli/src/report/file-verb.ts`. A filing from a stale checkout stays legal.
>
> **(c) accepted — triage folds a duplicate whatever its provenance.** `fabrika triage kill --duplicate-of <survivor>` may close a duplicate whether it was agent-filed or human-filed, once the triager has read both issues and judged them the same observation; no founder ruling is owed for a dup close. The `HUMAN_FILED` refusal in `packages/fabrika-cli/src/triage/kill-verb.ts` therefore no longer applies on the `--duplicate-of` path. **It survives unchanged everywhere else** — every close that is not a `--duplicate-of` fold still refuses a human filing, which is the whole reason the park route exists.
>
> That refusal is where ADR [0159](0159-never-auto-close-signal-is-the-report-footer.md)'s never-auto-close rule is enforced, so this ruling **narrows 0159 on the `--duplicate-of` path only** — the same shape the #4619 operator-author ruling took in ADR [0258](0258-report-footer-is-a-pinned-wire-format.md). 0159 remains the authority on the human-vs-agent-filed signal and on the never-auto-close rule everywhere else: a footer-absent filing is still protected from every close that is not a duplicate fold. Read absolutely, 0159 now states a rule that is no longer whole, so it carries an amendment of its own recording the narrowing.
>
> Four prose surfaces state the old rule and follow with the code: `.decisions/0159-never-auto-close-signal-is-the-report-footer.md` (the narrowing above), `claude-plugins/fabrika/skills/triage/SKILL.md` (step 4's "only an agent filing may be left as an empty husk and killed" and step 8's "a human filing is parked, never killed") and `claude-plugins/fabrika/skills/triage/contract.md` (the `triage kill` row and its exit `12` entries).
>
> This amendment records the choice and ships no code. The implementation is tracked as #6923 (the (a) widening) and #6924 (the (c) fold plus its four surfaces, ADR 0159's amendment among them). Admitted as transcription per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
