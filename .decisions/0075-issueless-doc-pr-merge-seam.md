---
id: 0075
title: A docs-only PR may merge with no linked issue — ship-it Step 1 carves out the doc lane
status: accepted
date: 2026-06-16
tags: [pipeline, ship-it, review-doc, decisions, adr, autonomy]
---

# 0075 — A docs-only PR may merge with no linked issue — ship-it Step 1 carves out the doc lane

## Context

`ship-it` Step 1 ([ship-it/SKILL.md](../claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md), "Resolve the PR and its
linked issue") reads the linked issue from the PR body's `Fixes #N` / `Closes #N` and treats
a **missing** link as a **hard stop** (`no linked issue`). Its stated premise: in this
pipeline `write-code` always writes `Fixes #N`, so a missing link is *a broken seam, not a
normal state* — an unlinked PR has nothing to auto-close on merge and would leave dangling
work (the rationale traces to ADR [0048](0048-ship-it-merge-actor.md) §1, "a linked issue is
expected, not optional").

That premise holds for the **code lane** and fails for the **doc lane**. A decision-of-record
can be authored straight from a conversation via [`/adr`](../claude-plugins/kampus-pipeline/skills/adr/SKILL.md): it produces
a file under `.decisions/**` (or `.patterns/**`, or prose `*.md`) with **no originating
issue** — nothing for a `Fixes #N` to close, because the work *is* the recording of a settled
choice, not the closing of a tracked task. Such a PR can never carry a real `Fixes #N`, so it
trips Step 1's hard stop and can never flow to merge through `ship-it`. This is a recurring
class, not a one-off: every conversation-authored ADR/doc PR hits it.

ADR [0053](0053-control-plane-boundary.md) already decided how a `.decisions/**` PR *should*
flow: it is **non-blocking** and **`review-doc`-gated** — it ships autonomously on a
`review-doc: PASS` exactly as code ships on a `review-code: PASS`, with no human at the merge
adding security value. The Step 1 `no linked issue` hard stop silently contradicts that: a
clean, `review-doc`-PASSed doc PR with no issue is refused before its gate verdict is even
consulted, so the doc lane 0053 promised is in fact closed for the most common doc artifact.

The **triggering instance is already resolved**: PR #418 (ADR 0072, branch
`umut/adr-milestone-strategy`) had a `review-doc` PASS bound to head `a6d636e` but no
`Fixes #N`; `ship-it` refused at Step 1 and it was **merged by hand** — fine, because a
`.decisions/**` PR is manual-mergeable under 0053 anyway, so the refusal was side-stepped, not
blocking. So this ADR settles the **durable seam**, not an open blocker.

This is **distinct from** ADR [0074](0074-adr-number-claim-lock.md) (the `/adr`
number-allocation race) and from the *linked-but-didn't-auto-close* recovery `ship-it` Step 5
already handles (there the seam fired but GitHub didn't close the issue — recoverable; here
the seam is *legitimately absent*).

### Options considered

1. **Carve-out — a docs-only PR is a legitimate no-linked-issue state. Chosen.** Teach
   `ship-it` Step 1 that when the PR diff is **docs-only** (classified `docs` by Step 0 with
   **no** code class present — i.e. only `.decisions/**`, `.patterns/**`, and prose `*.md`
   outside `.claude/`/`.github/`), a missing `Fixes #N` is **not** a broken seam: skip the
   auto-close expectation and ship on the `review-doc: PASS` alone. A *code* class present in
   the diff still hard-stops on a missing link. Risk: it relaxes a guard that catches
   genuinely-dangling code PRs — mitigated by scoping the relaxation strictly to docs-only
   diffs, so the dangling-code guard is untouched.

2. **Require-link — keep Step 1 strict; make `/adr` mint + link a `type:decision` issue.**
   Rejected. Every hand-authored ADR would first open a tracking issue purely to give the PR a
   `Fixes #N` to close, then immediately close it on merge. Trade-off: ceremony on every
   ad-hoc ADR — and a *false* seam, since a settled-decision ADR records a choice that was
   never tracked work; the minted issue exists only to satisfy a guard, carrying no triage
   value and adding queue noise. It also pushes against 0053, which deliberately routes docs
   *autonomously* through `review-doc` rather than through the issue-pipeline ceremony the code
   lane needs.

3. **Drop the Step 1 link guard entirely (for all classes).** Rejected. The guard earns its
   place on the code lane: a `write-code` PR with no `Fixes #N` *is* a broken seam (dangling
   work, nothing to auto-close), and that is exactly the anomaly 0048 wants `ship-it` to stop
   on. Dropping it wholesale would re-open the very gap the code lane relies on. The fork is
   genuinely *per-lane*, so the fix is per-lane.

## Decision

**A docs-only PR may merge with no linked issue.** `ship-it` Step 1's `no linked issue` hard
stop is **scoped to PRs whose diff carries a code artifact class**; for a **docs-only** diff a
missing `Fixes #N` is a legitimate state, and the PR ships on its `review-doc: PASS` alone.

Concretely, the follow-up implements this in `ship-it` Step 1 (no `/adr` change is needed —
`/adr` stays issue-free):

1. **Reuse Step 0's classification.** Step 0 already classifies the diff into artifact classes
   (`code` via `apps/web/**`/`packages/**`/`skills/**`-as-code per ADR
   [0063](0063-skills-are-code-gated.md); `docs` via `.decisions/**`/`.patterns/**`/prose
   `*.md`) and refuses control-plane PRs first. Step 1 keys off that result; it does **not**
   re-derive the classification.

2. **Branch the `no linked issue` rule on class.**
   - **Code class present** (code-only, or mixed code+docs) → **unchanged**: a missing
     `Fixes #N` is still a hard stop (`no linked issue`). The dangling-code guard stands.
   - **Docs-only** (Step 0 classed `docs` and **no** code class present) → a missing
     `Fixes #N` is **not** a stop. Skip resolving/auto-closing an issue and proceed to the
     gate check. If such a doc PR *does* carry a `Fixes #N`, honor it as today (resolve + let
     the squash-merge auto-close, with Step 5's explicit-close fallback).

3. **The gate is still required.** This relaxes only the *linked-issue* guard, never the
   *verdict* guard: a docs-only PR still ships **only** on a latest `review-doc: PASS` for its
   head SHA (ADRs [0053](0053-control-plane-boundary.md) §4,
   [0058](0058-sha-bound-verdict-contract.md)). Control-plane refusal (Step 0) is also
   untouched — a doc that happens to live under `.claude/`/`.github/` is still blocking and
   human-merged.

The reporting string `no linked issue` is retained for the code lane; the docs-only path emits
no such refusal (it is a normal state, not an anomaly).

## Consequences

- **The doc lane 0053 promised is actually open.** A clean, conversation-authored ADR/doc PR
  reaches merge through `ship-it` on its `review-doc: PASS`, with no manufactured tracking
  issue — Step 1 stops contradicting 0053's "non-blocking, `review-doc`-gated, autonomous"
  routing for `.decisions/**`/`.patterns/**`.
- **`/adr` stays ceremony-free.** No minted-then-closed `type:decision` issue per ADR; the
  authoring path is unchanged. (Aligned with 0074, which already governs how `/adr` claims its
  *number* — this ADR governs whether it needs an *issue*, and the answer is no.)
- **The code-lane guard is intact.** A code or mixed PR with no `Fixes #N` still hard-stops:
  the relaxation is scoped strictly to docs-only diffs, so the dangling-code anomaly 0048
  guards against is unaffected.
- **Banned:** refusing a docs-only PR solely for lacking a `Fixes #N`; minting a tracking
  issue just to give a hand-authored ADR a link to close; relaxing the link guard for any diff
  carrying a code class; shipping any doc PR without a current-head `review-doc: PASS`.
- **Relationship:** extends [0048](0048-ship-it-merge-actor.md) §1 (narrows "a linked issue is
  expected" to the code lane) and realizes [0053](0053-control-plane-boundary.md)'s doc lane
  end to end; the gate contract ([0058](0058-sha-bound-verdict-contract.md)) and Step 0
  classification ([0063](0063-skills-are-code-gated.md)) are unchanged.
- **Implementation is a follow-up, not this PR.** The `ship-it` Step 1 guard tweak ships as
  issue [#434](https://github.com/kamp-us/phoenix/issues/434) (`status:needs-triage`, milestone
  *Pipeline hardening*). This PR is
  `.decisions/**`-only (non-control-plane) and therefore itself rides the very doc lane it
  describes — `review-doc`-gated, and (until the follow-up lands) human-merged because Step 1
  still refuses it for lacking a `Fixes #N`. That self-reference is the point: the seam this
  ADR settles is the one its own PR trips.
