---
id: 0161
title: "Containment exempts a client-only presentational change — a dark flag protects an autonomous behavior change, not a visual result, so a change with no behavior to validate dark is stamped exempt per-PR"
status: proposed
date: 2026-07-05
tags: [process, release-engineering, pipeline, containment, threat-model]
---

# 0161 — Containment exempts a client-only presentational change

## Context

ADR [0083](0083-agents-deploy-humans-release.md) drew the agents-deploy / humans-release
boundary: an autonomously-merged **user-facing behavior change** ships **dark** behind a
default-off flag, and a human flips the flag to release it. The pipeline carries that per
child as the `**Containment:**` marker (`flag (default-off)` | `exempt (<reason>)` | `none`)
— a **plan-epic per-child stamp**, written once by plan-epic when a cycle doc is present, read
by write-code and review-code; it is **not** a triage default, and a missing line reads as
`none` (`gh-issue-intake-formats.md` §2).

The four-pillars audit wave then produced a run of PRs that are **client-only** —
visual/perf/a11y changes with no data, logic, or security surface: #2181 (async perceived-perf,
after its `defer` leg was removed it was pure client render), #2166 (CSS a11y), #2183 (density
toggle). ADR-0083 containment was stamping these `flag (default-off)`, forcing a **dark release**
— a flag, then a manual human flip — on changes that have **nothing to validate dark**. The
founder's principle names the resolution directly:

> "all of these improvements should not require dark release."

This ADR records that a well-defined class of change is **exempt** from ADR-0083 dark-release
containment. It refines ADR-0083's containment **scope**; it does not supersede it. It invents
no policy — it encodes the founder's already-declared call and draws the boundary precisely.
Because it **relaxes a guard**, the threat model below is the load-bearing content: a too-wide
exemption re-opens exactly what 0083 closed.

## Threat model (the load-bearing section — stated, not assumed)

**What ADR-0083 containment protects.** The dark flag holds an **autonomously-merged behavior
change** dark until a **human validates the behavior**. The no-eyeball auto-ship model removed
the merge-time human eyeball (ADR 0083 §Context); the flag is what replaces it — it guards
against an agent shipping a **wrong or harmful behavior live** to users before any human has
confirmed the behavior is what was intended. The thing being contained is a *behavior*: a data
mutation, a logic branch, an auth or access decision, a persisted or observable state change —
something that, if wrong, does damage to users or data the moment it is live.

**Why a client-only / unconditional presentational change has nothing for it to protect.** Such
a change has **no data mutation, no logic branch, no behavior flag, no auth decision, no
persisted or observable state change**. Its only output is a **visual / presentational result**
— how something looks or how quickly it appears to render. That output is validated by
**review-design plus the deployed e2e**, not by a dark flag: there is no behavior for a human to
"validate dark," because the only thing to validate is the pixels, which the design review and
the deployed end-to-end test already see. A dark flag on such a change adds **ceremony** (a flag
to author, gate, and later retire) and a **manual human flip**, and it reduces **zero** risk —
there is no live behavior the flip is protecting users from. The flag would be a no-op guard: it
holds back nothing dangerous.

**Where the line is (this boundary is the whole ADR — it must be tight).**

- **EXEMPT — contains as `exempt`, no dark flag required:**
  - **CSS-only / unconditional presentational changes** — a change whose entire user-facing
    effect is visual (styling, layout, spacing, density, motion) and is applied unconditionally,
    with no branch on data, user, or state.
  - **Pure client perceived-perf with no data / logic / security surface** — the #2181 class:
    once its `defer` leg was removed it was pure client render, changing *when/how fast* the UI
    appears, not *what* it computes, mutates, or authorizes.

- **NOT EXEMPT — contains normally (`flag (default-off)`, ships dark):**
  - Anything that touches **data** (a mutation, a read that changes what is persisted or served),
    **logic** (a new branch/decision on behavior), a **behavior flag**, **auth** (an access or
    permission decision), or a **persisted / observable state change**. Any one of these is a
    behavior — exactly what ADR-0083 exists to hold dark — and it contains normally.

**Residual risk of the exemption, and why it is acceptable.** The one risk is
**mis-classification**: a change that *looks* client-only but smuggles in a data/logic/auth
surface, stamped `exempt` and thus shipped live without a dark flag. That risk is bounded by two
gates, not by trust:
1. The **exemption is applied per-PR with an explicit client-only confirmation** (see Decision).
   The reviewer confirms the diff is presentational — a mis-stamp is caught at review, not
   silently accepted.
2. A change that **does** carry a data/logic/auth/state surface **is not exempt by definition** —
   it falls in the NOT-EXEMPT set and contains normally. The exemption is a *classification*, not
   an override: it never lets a real behavior change ship without its dark flag. If a surface
   sneaks in, the correct outcome is that the PR was mis-classified and should have contained —
   the exemption did not authorize the leak, it was misapplied, and the per-PR confirmation is the
   place that catch happens.

So the exemption removes ceremony from the class that had nothing to protect, without widening
the class that does. A too-wide exemption (e.g. "any refactor," "anything that looks safe") would
re-admit behavior changes past the guard — that is why the line is drawn at *presentational
output only*, and why data/logic/auth/state is a hard boundary, not a soft heuristic.

## Decision

**A client-only / unconditional presentational change is exempt from ADR-0083 dark-release
containment.**

1. **The exempt class** is exactly the EXEMPT set above: CSS-only / unconditional presentational
   changes, and pure client perceived-perf with no data / logic / security surface. Everything in
   the NOT-EXEMPT set — data, logic, a behavior flag, auth, or a persisted/observable state change
   — contains normally (`flag (default-off)`).

2. **Per-PR discipline, recorded not silent.** The exemption is applied **per-PR** with an
   **explicit client-only confirmation**. The `**Containment:**` marker is set to
   `exempt (<reason>)` on the work item — `exempt (client-only presentational)` or the equivalent
   naming the presentational surface — and that stamp is **recorded**, not omitted. **Silence is
   not opt-out:** a bare/absent marker reads as `none` under the tolerant-read rule and is a
   different statement than a deliberate `exempt`; claiming the exemption means *saying so*, so the
   classification is legible to the reviewer and to future readers. This reuses the existing
   `exempt (<reason>)` value in the `**Containment:**` taxonomy (`gh-issue-intake-formats.md` §2)
   — no new marker.

3. **The stamp stays a plan-epic per-child concern**, not a triage default (`gh-issue-intake-formats.md`
   §2). Triage does not default a containment value; plan-epic writes it per child from the cycle
   policy, now including this exempt class for a client-only child.

## Consequences / enforcement

- **review-code's §ZS surface regex must cover `.css`** so a CSS-only PR is correctly *in scope*
  for the surface scan rather than reading as an empty-surface artifact. The current surface regex
  (`review-code/SKILL.md` Step 3b) matches `apps/web/src/**/*.tsx` and `apps/web/worker/**/*.{ts,tsx}`
  and **omits `.css`** — a CSS-only diff currently matches nothing. That fix is #2185(b) (in flight);
  it is a prerequisite for a CSS-only PR to be classified rather than fall through.
- **The intake-formats / plan-epic guidance encodes the exempt class** so plan-epic stamps a
  client-only child `exempt (<reason>)` rather than `flag (default-off)`. That is #2185(a), which
  **follows this ADR** (the ADR draws the boundary; the guidance encodes it).
- **This ADR must be ratified by the founder before merge.** The boundary is his call — the
  `status` is `proposed`, not `accepted`, until umut ratifies it. It also **must be adversarially
  reviewed**: because it relaxes a guard, the threat model above is what a reviewer must attack —
  specifically the tightness of the EXEMPT vs NOT-EXEMPT line and the sufficiency of the per-PR
  confirmation as the mis-classification catch.

## Relationship to prior decisions

- **Refines (does not supersede) ADR [0083](0083-agents-deploy-humans-release.md)** — it narrows
  the *scope* of dark-release containment to behavior changes, leaving 0083's agents-deploy /
  humans-release boundary intact for everything that carries a behavior.
- **Relates to** the `**Containment:**` marker taxonomy in `gh-issue-intake-formats.md` §2 (the
  `exempt (<reason>)` value it reuses), the review-code §ZS surface gate
  (`review-code/SKILL.md` Step 3b), and ADR [0092](0092-gates-fail-closed-on-zero-scope.md)
  (the fail-closed-on-zero-scope rule the §ZS `.css` fix keeps honest).
- **Tracked work:** #2185 (§ZS `.css` coverage (b) + plan-epic exempt-class guidance (a)),
  #2181 (async perceived-perf), #2166 (CSS a11y), #2183 (density toggle) — the client-only PRs
  that motivated the exemption.
