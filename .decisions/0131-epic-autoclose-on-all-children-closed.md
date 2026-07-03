---
id: 0131
title: Auto-close an epic when all its children close — a close-triggered Action, all epics regardless of filer
status: accepted
date: 2026-07-02
tags: [pipeline, github-actions, epics]
---

# 0131 — Auto-close an epic when all its children close

## Context

This is a conversation-authored decision made by the founder — the ADR [0075](0075-issueless-doc-pr-merge-seam.md) exception — resolving triaged issue [#1767](https://github.com/kamp-us/phoenix/issues/1767).

The pipeline had **no mechanism** to close an epic once all its children close. A human had to remember to hand-close it (#1637 earlier; #1746 was sitting open with both children — #1747, #1748 — already merged). This is easy to forget, and an open-but-complete epic obscures the true backlog state: it reads as in-progress when it is done.

The obvious "put it in `ship-it`" **does not work**. `ship-it` owns `PASS → merge` for agent-shipped PRs, but it **refuses §CP control-plane PRs** — those stop at reviewed-ready for a human hand-merge (ADR [0048](0048-ship-it-merge-actor.md) / [0053](0053-control-plane-boundary.md)). A §CP child is therefore closed by a human `gh pr merge`, which `ship-it` never runs for — so a `ship-it`-based auto-close is structurally blind to it. Concretely, **both of #1746's children (#1747, #1748) were §CP human merges**; a `ship-it`-hooked auto-close would have missed #1746 entirely. The trigger must fire on *any* child close, whoever performed it.

## Decision

An epic auto-closes when all its children close, via a **close-triggered GitHub Action** (`.github/workflows/epic-autoclose.yml`), **not** via `ship-it`.

1. **Mechanism — `issues.closed`.** On any issue close, resolve the closed issue's parent epic; if every child of that epic is now closed, close the epic with an explanatory comment. Because it hooks GitHub's own `issues.closed` event, it fires for **every** child close — agent (`ship-it`) merges *and* §CP human hand-merges alike. This is the whole reason it is a close-triggered Action rather than a `ship-it` step: `ship-it` cannot see the §CP human-merge close, the event can.

2. **All epics, regardless of filer.** This applies to **every** `type:epic`, founder-filed umbrellas included. It **deliberately overrides the "human-filed issues are never auto-closed" rule — but for epics specifically.** An epic is a pure coordination container: its completeness is fully determined by its children's states, so closing it on all-children-closed carries none of the "an agent decided a human's issue is done" risk the human-filed rule guards against. That rule **still holds for every non-epic human-filed issue** — the carve-out is scoped to `type:epic` and nothing else.

3. **Authoritative linkage — native GitHub sub-issues.** "Are all children closed?" is answered against the **native sub-issue** parent/child edge that `plan-epic` Step 4 writes (`POST /issues/<epic>/sub_issues`), *not* the `## Dependencies` body topology (which orders children among themselves — it is not the parent edge). The Action resolves a closed issue's parent with `GET /issues/<child>/parent` (the child's own `.parent` field in the plain issue payload is unreliably null; the dedicated sub-endpoint is the source of truth) and enumerates the epic's children with the `GET /issues/<epic>/sub_issues` **list** — never `sub_issues_summary`, which is documented to undercount under mixed open/closed children.

All GitHub calls in the Action go through `gh api` REST, never GraphQL — the org's legacy Projects-classic integration breaks GraphQL issue/PR queries (the same constraint the pipeline skills carry, ADR 0062).

## Guards — why it never closes an epic prematurely or loops

- **Not a child ⇒ no-op.** `GET /issues/<child>/parent` returns 404 ("No parent issue found") for a standalone issue or a top-level epic → clean stop.
- **Not a `type:epic` parent ⇒ no-op.** Only a `type:epic` parent cascades.
- **Empty child set ⇒ no-op (fail-closed, ADR [0092](0092-gates-fail-closed-on-zero-scope.md)).** An epic with zero linked sub-issues is never auto-closed on a spurious trigger — positive evidence of a complete, non-empty, all-closed child set is required to act.
- **Any open child ⇒ no-op.** The epic closes IFF *every* child is closed.
- **Loop-safe / terminating.** Closing the epic re-fires `issues.closed` for the epic. A top-level epic has no parent → 404 → stop. A nested epic (an epic that is itself a child) still terminates: its grand-parent closes only once **all** its children — the nested epic included — are closed, and the **already-closed guard** (an epic that is not `open` is a no-op) makes any re-close a no-op. The cascade converges upward and halts; it cannot cycle.

## Consequences

- The epic list stays honest with zero human toil — an epic disappears from the open backlog the instant its last child closes, no matter who closed it.
- It is `.github/workflows/**` → **§CP control-plane**: changes to it are `review-skill`/review-gated and human hand-merged, never auto-shipped.
- The auto-close is reversible by hand: the closing comment tells a human to reopen a child and reopen the epic if the close was premature.
- **Limitation — native-sub-issue epics only (an accepted boundary).** The Action auto-closes **only** epics whose children are linked as **native GitHub sub-issues** — i.e. `plan-epic`-born epics linked via `POST /issues/<epic>/sub_issues` (e.g. #1751). It does **not** auto-close a **hand-split / body-linked** epic (children referenced only in prose, like #1746's #1747/#1748): such an epic has an **empty native child set**, so the fail-closed empty-scope guard leaves it open, and it still needs a **manual hand-close**. Native sub-issues are the norm going forward (every `plan-epic` epic gets them), so this is an accepted boundary, not a gap to patch — but it is called out explicitly so nobody expects a body-linked epic to auto-close.
