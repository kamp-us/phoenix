---
id: 0053
title: The control-plane boundary — blocking is .claude + .github; everything else is non-blocking + gated
status: accepted
date: 2026-06-13
tags: [pipeline, ship-it, review-code, review-doc, security, process]
---

# 0053 — The control-plane boundary — blocking is .claude + .github; everything else is non-blocking + gated

## Context

ADR [0049](0049-pipeline-ships-code-not-itself.md) drew the auto-merge boundary at
*product code vs. harness*: `apps/web/**` and `packages/**` could flow `write-code` →
`review-code` → `ship-it` and auto-merge, while **everything** under `.claude/**`,
`.decisions/**`, and `.patterns/**` was held back for a manual maintainer merge. The
stated reason was a general "the pipeline does not ship itself" intuition, enforced *for
free* by the fact that those PRs never received a `review-code` PASS.

Two problems surfaced with that line.

**1. It blocks too much.** `.decisions/**` (ADRs) and `.patterns/**` (how-the-code-is-shaped
docs) are **knowledge artifacts**, not the agent's control plane. An ADR or a pattern doc
cannot escalate an agent's privileges, rewrite a guardrail, or exfiltrate a secret — it is
prose the same as a product doc. Holding it for a manual merge bought no security; it only
parked autonomous knowledge work behind a human who, at the merge, was adding nothing a
gate could not. The right treatment for a doc is the same as for code: **gate it for
quality, then ship it autonomously.** What 0049 was missing was a *doc gate* to consume —
so it defaulted to "human merge" for lack of an automated verdict, not because a human at
the merge added safety.

**2. It blocks too little — a real gap.** 0049's banned-list named `.claude` /
`.decisions` / `.patterns`, but **never `.github`**. CI workflows, Actions, and their
secret-bearing configuration live under `.github/**`, and nothing in `ship-it`'s guard or
0049's boundary covered them. A PR editing a workflow file was, by 0049's own rules,
*not* in the blocked set — so a workflow edit could in principle auto-merge. That is the
most dangerous class of change in the repo: a malicious or buggy `.github/**` edit can
disable CI enforcement, leak repository secrets, or grant a workflow elevated
permissions. The control plane was drawn around the agent's *instructions* (`.claude`)
but left the *CI enforcement* (`.github`) outside the fence.

The fix is to redraw the boundary around the thing that actually matters for security —
the **control plane** — and to give docs a real gate so they can ship autonomously like
code.

## Decision

The auto-merge boundary is the **control plane**, not "code vs. harness." Two classes:

### 1. BLOCKING — the control plane: `.claude/**` and `.github/**`.

A PR whose diff touches **any** file under `.claude/**` or `.github/**` is **never
self-merged by the pipeline**. A human merges it by hand.

- `.claude/**` is the agent control plane — the skills, agents, hooks, and settings that
  *are* the pipeline. Auto-merging an edit to the machine that performs the merge is
  self-modification of the guardrails: a circuit-breaker waiting to fail.
- `.github/**` is the CI/enforcement control plane — workflows, Actions, and their
  secret-bearing config. A bad merge here can disable CI checks, exfiltrate repository
  secrets, or escalate workflow permissions. **This is the gap 0049 left open**: its
  blocked-set omitted `.github`, so a workflow edit fell through to the autonomous lane.
  0053 closes it.

A bad merge in either tree is a serious security concern, and a human at the merge is the
point — not a quality check a gate could replace.

### 2. NON-BLOCKING — everything else: autonomous, gated for quality.

Everything outside the control plane ships autonomously once its matching gate PASSes:
`apps/web/**`, `packages/**`, `.decisions/**`, `.patterns/**`, and other prose docs.

- `apps/web/**` and `packages/**` are deployable product code.
- `.decisions/**` and `.patterns/**` are **knowledge artifacts** — prose that records the
  *why* and the *shape*. They cannot escalate privilege or leak a secret, so a human at
  their merge adds no security value. They move from 0049's manual lane to the autonomous
  lane, **gated by a quality reviewer** (`review-doc`), not by a human hand.

### 3. Gate markers by artifact class present in the PR diff.

- **Product code** (`apps/web/**`, `packages/**`, other code) → `review-code` emits a
  first-line marker, exactly as today:
  - `review-code: PASS — merge-ready`
  - `review-code: FAIL — not merge-ready`
- **Docs** (`.decisions/**`, `.patterns/**`, prose `*.md` **outside** `.claude/` and
  `.github/`) → **`review-doc`** emits a first-line marker:
  - `review-doc: PASS — merge-ready`
  - `review-doc: FAIL — changes-requested`

`review-doc` becomes a **real, `ship-it`-consumed gate** — not advisory. Under 0049 docs
had no automated verdict and so defaulted to a manual merge; under 0053 a doc PR ships
*only* on a `review-doc: PASS`, exactly as a code PR ships only on a `review-code: PASS`.

### 4. `ship-it` routing.

1. **Control-plane refusal first.** If the PR diff touches **any** file under `.claude/**`
   or `.github/**`, `ship-it` **refuses** and reports `blocking — manual merge`. This
   check precedes any gate-verdict check; a control-plane PR is never merged on a PASS.
2. **Otherwise, require the matching gate's latest verdict = PASS for each artifact class
   present in the diff:**
   - code present → `review-code` latest = PASS;
   - docs present → `review-doc` latest = PASS;
   - mixed code + docs → **both** PASS.
3. **Two separate marker namespaces.** `ship-it` matches the two markers with two anchored
   regexes — e.g. `^\s*review-code:\s*(PASS|FAIL)` and `^\s*review-doc:\s*(PASS|FAIL)` — so
   a `review-code` scan never matches a `review-doc` marker and vice versa. **Latest-verdict-
   wins per namespace**, by comment timestamp, as today.

The single-operator marker-comment reality from ADR [0048](0048-ship-it-merge-actor.md)
is unchanged: `review-doc` posts its PASS as a marker comment the same way `review-code`
does, because the operator cannot approve their own PR.

## Consequences

- **Safer where it matters:** the control plane is now the *whole* control plane. `.github`
  is blocked (closing 0049's workflow-edit gap), and `.claude` stays blocked. CI/secret
  exfiltration and guardrail self-modification both require a human hand on the merge.
- **More autonomous where it's safe:** `.decisions/**` and `.patterns/**` move from manual
  merge to the autonomous, `review-doc`-gated lane. Knowledge work ships end to end without
  a human at the merge, gated for quality the same way code is.
- **`review-doc` is now load-bearing:** it is a `ship-it`-consumed gate, not an advisory
  pass. A doc PR with no `review-doc: PASS` does not ship; a `review-doc: FAIL —
  changes-requested` routes the PR back for revision, symmetric to `review-code: FAIL`.
- **Two namespaces, never crossed:** the anchored, separately-namespaced regexes mean a
  mixed code+doc PR is held to *both* gates, and neither scan can be satisfied by the other
  class's marker.
- **Banned:** auto-merging any PR that touches `.claude/**` or `.github/**` (refuse →
  manual merge); shipping a doc PR without a `review-doc: PASS`; a single regex that
  conflates the two marker namespaces; treating `review-doc` as advisory; the old 0049
  treatment of `.decisions`/`.patterns` as manual-merge-only.
- **Edge — mixed control-plane + non-control-plane PR:** if the diff touches `.claude/**`
  or `.github/**` *at all*, the whole PR is blocking (refusal wins over any PASS). Such a
  PR should be split so the non-control-plane half can flow through its gate autonomously.
- **Supersedes [0049](0049-pipeline-ships-code-not-itself.md).** 0049's boundary
  (product-code-only auto-merge; `.claude`/`.decisions`/`.patterns` manual) is replaced by
  this control-plane boundary: blocking = `.claude` + `.github`; everything else is
  non-blocking and gated (`review-code` for code, `review-doc` for docs).
- **Relationship:** builds on [0048](0048-ship-it-merge-actor.md) (`ship-it` is the single
  merge authority consuming a PASS marker) — 0053 adds a second consumed marker namespace
  (`review-doc`) and a pre-gate control-plane refusal. Complements
  [0047](0047-review-plan-gate.md) (the plan-layer gate) and
  [0046](0046-plan-epic-prd-grade-plans.md) (plan-epic).
