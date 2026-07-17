---
id: 0194
title: Design-law JSDoc firewall — descriptive component inventory vs. founder-authored normative law, minimal-v1 schema
status: accepted
date: 2026-07-17
tags: [design-system, docs, glossary, agents]
---

# 0194 — Design-law JSDoc firewall

**What this decides:** Agents may auto-generate the *descriptive* half of the design docs — the component inventory (which primitives exist, their props/slots, and a per-component when-to-use) — but the *normative* half (the four pillars, the prohibitions, and the role-token values in `design-system-manifest.md`) stays founder-authored and is never auto-written; the two are separated by a hard firewall, and the metadata carrying the descriptive half is a deliberately-minimal JSDoc schema that we expect to evolve with real use.

## Context

Design coverage (#3152) needs an extractor/agent that keeps component documentation current without letting an agent quietly rewrite the design *law*. The four-pillars design law ([0162](0162-four-pillars-design-law.md)) is the founder-authored normative manifest that `write-code` reads before generating UI; ADR [0078](0078-product-driven-decisions-by-default.md) fixes that product/design decisions are founder-ratified, not agent-minted. An extractor that regenerates docs sits exactly on that boundary — so the boundary has to be drawn firmly before any annotation (#3153) or rollout (#3154) work begins.

The founder ratified the shape on 2026-07-17 (issue #3152). This ADR records that settled decision. It is not re-deciding anything: the firewall is ratified *firmly* as the durable boundary, while the JSDoc schema is ratified as a good-enough v1 that is **expected to evolve** — not an exhaustive final spec.

## Decision

**1. The descriptive/normative firewall (the durable boundary).**

- **Descriptive** — the extractor/agent MAY generate and update: the *component inventory* — the primitives that exist, their props/slots, and a per-component **when-to-use**.
- **Normative** — founder-authored, NEVER auto-written: the four pillars, the prohibitions, and the role-token values in `design-system-manifest.md` ([0162](0162-four-pillars-design-law.md)).
- **The firewall on the edge case (per-component when-to-use).** A component's when-to-use lives *on* the component but is `@agent`-generated and **references** the manifest's law — it never mints new law. It is a descriptive echo that *points at* the normative, not a second copy of it. This is the [0078](0078-product-driven-decisions-by-default.md) guard applied at the doc layer: an agent may describe what exists and cite the law, but only the founder writes the law.

**2. The JSDoc metadata schema + output — a deliberately-minimal v1, expected to evolve.**

- Metadata lives as **JSDoc tags on each primitive**: `@component`, `@slot`, prop docs, and `@agent` directives (the protected, human-seeded steering the extractor must preserve).
- **Source of truth = JSDoc + code, colocated** in the component file.
- **Output = one central curated-hybrid INDEX** — inline the when-to-use core, link to source for depth (the effect-smol `LLMS.md` idiom).
- **Enforcement = a generate command + a fail-closed drift guard** (pre-commit + CI), so a stale or hand-diverged index reddens rather than rots.
- Keep the tag vocabulary **lean**; iterate as real use surfaces gaps. This v1 is intentionally under-specified — do not treat this section as a frozen final spec.

## Consequences

- The boundary is now explicit and citable: an extractor may regenerate the component inventory freely, but any change to the four pillars / prohibitions / role-token values is a founder edit to `design-system-manifest.md`, out of the agent's reach. A per-component when-to-use that mints new law (rather than referencing it) is a firewall violation.
- Unblocks #3153 (pilot annotation of the first primitive) → #3154 (rollout). Those build against this schema.
- The schema is expected to change: as annotation surfaces gaps, the tag vocabulary grows by iteration, not by re-litigating the firewall. The firewall is fixed; the schema is a living v1.
- A new drift guard (generate + fail-closed check) joins the CI guard family; a component whose index row diverges from its JSDoc reddens the build.
- Three nouns enter the shared vocabulary (`.glossary/TERMS.md`): `@agent` directive, descriptive component inventory, and descriptive/normative firewall.
