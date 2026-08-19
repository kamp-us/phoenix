---
id: 0209
title: The taste voice — per-aspect taste skills grounded in the design law, never authoring it
status: accepted
date: 2026-07-24
tags: [design, pipeline, agents]
---

# 0209 — The taste voice — per-aspect taste skills grounded in the design law, never authoring it

**What this decides:** The factory gets design taste as a library of per-aspect skills (typography, motion, color, layout/spacing, iconography, forms, copywriting) that the existing coder/planner agents load by name when creating UI — each skill a set of strict generative rules grounded in the repo's design law, never a persona agent and never a source of new law.

## Context

The factory's design law + gates supply *consistency* but not *direction* — nothing in the loop
said what a UI *should be*. The gates (`review-design`, the golden/flake canon) can fail a screen
for violating the law, but no primitive shapes the creation so the screen is worth passing.

Constraints that shaped the ruling:

- **Grounding is exclusively the repo's design law**: [`design-system-manifest.md`](../design-system-manifest.md)
  (ADR [0162](0162-four-pillars-design-law.md)) + the descriptive component inventory
  (ADR [0194](0194-design-law-jsdoc-firewall.md)) + the blessed goldens
  (ADR [0183](0183-golden-screen-storage-depo-git-pointer.md)). There is no empty output-artifact
  slot — normative/descriptive/visual all exist; the skills consult them, never add a fourth
  artifact or mint law. The ADR 0194 firewall stays intact; law changes keep flowing through the
  existing ADR-ratify→transcribe path.
- **Field grounding**: the state of the art converges on extracted-design-law grounding over
  persona taste (surveyed on #3926); ungrounded persona advisors fight the conformance gates.
- **Seed**: `emilkowalski/skills` (MIT, seven per-aspect skills) is adopted/adapted with
  attribution (its embedded course plug stripped); repo-grown manifest-grounded seeds cover the
  aspects it doesn't (color, layout/spacing, iconography, forms, copywriting).
- **The loop's interactive eye** is `vercel-labs/agent-browser` — compose, don't replace:
  `design-capture`/`local-render` + the golden/flake canon remain the gate substrate. Promoting
  instrumented measurements into `review-design` FAIL classes is a future, separate ADR.

Founder-ruled 2026-07-24 on wayfinder:map #3227 (sub-issue #3910) — a conversation-authored
ruling recorded directly per the ADR [0075](0075-issueless-doc-pr-merge-seam.md) seam.

## Decision

**The factory's design-taste primitive is an advisor shaped as a library of per-aspect taste skills — strict generative rules with the *why* attached — loaded by name into existing generalist agent spawns (coder/planner) when creating UI; it is NOT a persona agent, NOT an author of normative design law, and NOT a new agent def.**

The rule shape is strict and generative: decision tables with hard thresholds, text flowcharts,
and imperative rules each carrying a concrete value, a one-line *why*, and a named counterexample.
Taste enters as creation-shaped guidance held to the same law the gates enforce — so the advisor
can never fight its own gate.

**Binding constraints.**
- Grounding is exclusively the design law: manifest ([0162](0162-four-pillars-design-law.md)) + descriptive inventory ([0194](0194-design-law-jsdoc-firewall.md)) + blessed goldens ([0183](0183-golden-screen-storage-depo-git-pointer.md)) — no fourth artifact.
- Skills consult the law, never mint it — the 0194 firewall holds; law changes flow through ADR-ratify→transcribe.
- Delivery is skill-loading into existing generalist spawns — no persona agent, no new agent def.
- `agent-browser` composes with the gate substrate (`design-capture`/`local-render` + golden/flake canon), never replaces it; new instrumented FAIL classes need their own ADR.
- Adopted seeds carry attribution (`emilkowalski/skills`, MIT), with the embedded course plug stripped.

**Rejected alternatives.**
- (b) An author emitting normative design decisions — violates the code-enforced 0194 firewall and the manifest's surface-don't-fill rule.
- (c) A manifest-extender only — already operating de facto via ADR-ratify→transcribe; adds no creation-time taste.
- (d) Nothing — leaves creation taste-less, bottlenecking all design direction on the founder.

## Consequences

- Creation gets direction: an agent building UI holds generative per-aspect rules, not just
  FAIL classes to avoid — design direction stops bottlenecking on the founder.
- Advisor and gate share one source of truth (the design law), so taste guidance cannot
  contradict `review-design`.
- Aspect coverage grows incrementally: adopted seeds plus repo-grown manifest-grounded seeds,
  each a normal skill file under review.
- The skills carry a maintenance edge: when the law changes (via ADR-ratify→transcribe), the
  taste skills that cite the changed rule must follow — they lag the law, never lead it.
- Promoting `agent-browser` measurements into `review-design` FAIL classes stays open as a
  future, separate ADR.

## Records

- Provenance: founder-ruled 2026-07-24 on wayfinder:map #3227; frontier tickets #3903, #3910,
  #3926, #3930, #3932; emitted build epic #3946.
- Vocabulary impact: coins **taste skill** (and **the taste voice** as the primitive's name) —
  routed to `.glossary/TERMS.md` (Design coverage section) in this PR.
