---
id: 0184
title: review-code Step 1 gets the ADR-0075 issueless carve-out too — class-aware, mirroring review-doc — so a conversation-authored `.glossary/**` (CODE-class) vocab PR no longer self-deadlocks
status: accepted
date: 2026-07-14
tags: [pipeline, review-code, review-doc, glossary, adr, autonomy]
---

# 0184 — review-code Step 1 gets the ADR-0075 issueless carve-out too (class-aware)

## Context

ADR [0075](0075-issueless-doc-pr-merge-seam.md) settled that a **conversation-authored**
doc PR (a `/adr` or other prose artifact recording a settled choice) legitimately carries
**no linked issue** — the work *is* the recording, there is nothing for a `Fixes #N` to
close — and taught the doc lane's guards to carve that state out rather than hard-refuse it.
`review-doc` honors that carve-out today: a conversation-authored `.decisions/**` /
`.patterns/**` / prose PR with no `Fixes #N` still earns a `review-doc: PASS`.

`review-code` never got the matching carve-out. Its **Step 1**
([review-code/SKILL.md](../claude-plugins/kampus-pipeline/skills/review-code/SKILL.md),
"Resolve the PR and its linked issue") treats a missing linked issue as **"a fail you can't
even start"**: it comments that there's no linked issue to verify against and stops, because
without the linked issue there are no `### Acceptance criteria` to gate. That premise is
correct for the ordinary `write-code` PR — a code PR with no `Fixes #N` *is* a broken seam.

But it is **wrong for the conversation-authored vocabulary PR**, and that PR is CODE-class.
The glossary lives under `.glossary/**`, which is classified **code** (a structural surface
gated by `review-code`, not `review-doc`). So a conversation-authored PR that coins or
redefines vocabulary in `.glossary/LANGUAGE.md` / `.glossary/TERMS.md` — exactly the
primary-coining-site artifact ADR [0128](0128-glossary-concept-trigger-off-the-gate.md)
routes here — is routed to `review-code`, has no originating issue by construction, and so
**can never obtain a `review-code: PASS`**. That verdict is the merge gate, so the PR
**deadlocks `ship-it`** on the empty `review-code` namespace: `ship-it` waits for a verdict
that Step 1 refuses to ever produce.

This is not hypothetical: it forced **splitting the `LANGUAGE.md` vocabulary edit out of
PR #2996** because that PR could not clear the gate (see
[#2999](https://github.com/kamp-us/phoenix/issues/2999),
[#3000](https://github.com/kamp-us/phoenix/issues/3000)). The doc-lane carve-out ADR 0075
promised is real, but it stops at `review-doc`; a CODE-class conversation-authored artifact
falls into the exact gap 0075 closed for the doc lane.

### Options considered

1. **Extend the ADR-0075 issueless carve-out to `review-code` Step 1, class-aware — mirroring
   `review-doc`'s existing carve-out. Chosen.** Teach `review-code` Step 1 the same thing
   `review-doc` already knows: a **conversation-authored** artifact legitimately has no
   linked issue, and a missing `Fixes #N` on such a PR is a normal state, not "a fail you
   can't even start." Scope it exactly as 0075 scoped the doc-lane carve-out — to the
   conversation-authored class — so an ordinary `write-code` code PR with no `Fixes #N` still
   hard-stops (the dangling-code seam guard stands). This makes a conversation-authored
   `.glossary/**` vocab PR gate-able instead of self-deadlocking, and keeps `review-code`
   and `review-doc` **consistent** on the one question ("does a conversation-authored
   artifact need a linked issue?" — no, in both lanes).

2. **Mandate that every vocabulary PR ride a linked issue.** Rejected. It re-imposes the
   exact ceremony ADR 0075 already rejected for the doc lane (option 2 there): every
   conversation-authored vocab edit would first mint a `type:*` tracking issue purely to give
   the PR a `Fixes #N` to close, then immediately close it on merge — a *false* seam carrying
   no triage value, added only to satisfy a guard. Worse, it would make the two review lanes
   **inconsistent**: `review-doc` waives the linked issue for a conversation-authored artifact
   while `review-code` demands one for the same class of authorship, so which guard you hit
   depends only on whether the coined term happens to land in `.decisions/**` (doc-class) or
   `.glossary/**` (code-class) — an arbitrary split the author shouldn't have to route around.
   The friction is real and recurring: every conversation-authored vocab PR would pay it.

## Decision

**`review-code` Step 1's `no linked issue` refusal gets the ADR-0075 issueless carve-out,
class-aware, mirroring `review-doc`.** A **conversation-authored** PR (no originating issue —
the artifact records a settled choice, e.g. a `/adr`-adjacent `.glossary/**` vocabulary edit)
may be gated by `review-code` with **no `Fixes #N`**: Step 1 does not hard-refuse it for
lacking a linked issue. An ordinary `write-code` PR with no linked issue **still hard-stops** —
the carve-out is scoped to the conversation-authored class exactly as 0075 scoped the doc-lane
relaxation, so the dangling-code seam guard is untouched.

This closes the deadlock: a conversation-authored `.glossary/**` vocab PR (CODE-class, so
`review-code`-gated) becomes gate-able and can earn its `review-code: PASS` instead of
self-deadlocking `ship-it` on a verdict Step 1 would never produce.

The relaxation is **only** the linked-issue guard. Every other `review-code` gate stands: the
verdict is still SHA-bound (ADR [0058](0058-sha-bound-verdict-contract.md)), the glossary /
comment / staleness sub-gates are unchanged, and a guard-touching `.glossary/**`/`.decisions/**`
artifact still routes §CP by content where ADR [0164](0164-guard-relaxing-adr-cp-gate.md)
applies.

## Consequences

- **The conversation-authored CODE-class artifact stops self-deadlocking.** A vocab PR that
  coins/redefines a term in `.glossary/**` reaches a `review-code` verdict and can ship on
  PASS — the doc-lane openness of ADR 0075 now extends to the CODE-class coining site, so the
  choice of `.decisions/**` vs `.glossary/**` no longer changes whether the PR is gate-able.
- **The two review lanes are consistent.** `review-code` and `review-doc` answer "does a
  conversation-authored artifact need a linked issue?" the same way — no. An author no longer
  routes around an arbitrary lane-dependent split.
- **The dangling-code guard is intact.** An ordinary `write-code` PR with no `Fixes #N` still
  hard-stops at Step 1: the carve-out is scoped to the conversation-authored class, so the
  broken-seam anomaly the guard catches is unaffected.
- **Banned:** refusing a conversation-authored PR at `review-code` Step 1 solely for lacking a
  `Fixes #N`; minting a tracking issue just to give a conversation-authored vocab PR a link to
  close; relaxing the linked-issue guard for an ordinary `write-code` code PR; shipping any PR
  without a current-head `review-code: PASS`.
- **Relationship:** extends ADR [0075](0075-issueless-doc-pr-merge-seam.md)'s issueless
  carve-out from the doc lane (`review-doc`) to the code lane (`review-code`), class-aware;
  the SHA-bound verdict contract ([0058](0058-sha-bound-verdict-contract.md)), the glossary
  coining hook ([0128](0128-glossary-concept-trigger-off-the-gate.md)), and the guard-touching
  §CP predicate ([0164](0164-guard-relaxing-adr-cp-gate.md)) are unchanged.
- **Implementation is a follow-up, not this PR.** The mechanical edit to `review-code/SKILL.md`
  Step 1 implementing the class-aware carve-out is a separate follow-up — a §CP change to a
  guard skill, so it flows to *reviewed-ready* and cansirin's control-plane bank, not this doc
  PR. This ADR plus that edit resolve
  [#3000](https://github.com/kamp-us/phoenix/issues/3000) and unblock
  [#2999](https://github.com/kamp-us/phoenix/issues/2999)'s vocabulary PR.
