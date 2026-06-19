---
id: 0091
title: Infrastructure Epics Aren't Done Until a Real Product Feature Consumes Them in Production
status: accepted
date: 2026-06-19
tags: [process, pipeline, prioritization, product]
---

# 0091 — Infrastructure Epics Aren't Done Until a Real Product Feature Consumes Them in Production

## Context

The week of Jun 11–18 2026 ran the backlog at roughly **1:5 to 1:11 product-to-infra** — **9 of the last 12 ADRs are release-engineering plumbing**. The operation authors doctrine and builds capability far faster than it consumes either.

The flag/containment/release substrate is the clearest case. ADRs [0081](0081-feature-flag-substrate-cloudflare-flagship.md) (Flagship) and [0083](0083-agents-deploy-humans-release.md) (agents deploy / humans release), epic [#488](https://github.com/kamp-us/phoenix/issues/488), ~14 PRs — and it gates **zero product features**:

- The only `getBoolean` consumer is the synthetic `phoenix-health-probe`.
- `status:awaiting-release` has held **0 issues ever**.
- `Containment: flag` appears on **0 of ~720 issues**.
- Feature [#676](https://github.com/kamp-us/phoenix/issues/676) shipped **22h after** the machinery merged — straight past it, ungated.

An empty `awaiting-release` queue and a zero containment-marker count are not an all-clear; they are an **alarm**. Built capability with no consumer is not "done infrastructure," it is dead weight that rots unexercised (the silent-no-op gate is its sibling — see ADR [0092](0092-gates-fail-closed-on-zero-scope.md)). This violates the *spirit* of ADR [0078](0078-product-driven-decisions-by-default.md): product drives by default, engineering leads only where the work *is* the platform — and even platform work earns its keep by being consumed.

## Decision

**No infrastructure epic is "done" / closeable until at least one real product feature consumes it in production.**

- The **real consumer is an acceptance criterion of the infra epic itself**, not a deferred follow-up. An epic that builds a capability owns shipping the first feature that rides it.
- **`plan-epic` must stamp** every infra epic with an explicit real-consumer acceptance criterion (a named feature that will exercise the capability in production, not a synthetic probe).
- **`ship-it` / epic-close must verify** a real consumer exists before the epic closes.
- **Applied retroactively:** epic [#488](https://github.com/kamp-us/phoenix/issues/488) does **not** close until one real feature rides the flag substrate.

## Consequences

- **Redirects agent energy** from building machinery to shipping user value — the substrate exists to serve features, so a feature is what proves it works.
- **Enforced mechanically** by a `MISSING_CONTAINMENT` check in the epic-ledger validator (tracked by the "make the gates fire" epic), so a zero-consumer infra deliverable is a **defect signal surfaced by a doctrine-drift reconciliation job**, not something a human discovers a week later in retro.
- **Cost:** an infra epic now carries a product-feature dependency it cannot close without; this is intentional friction against shipping unconsumed machinery.
- **Relates to:** ADR [0078](0078-product-driven-decisions-by-default.md) (product-driven by default — this enforces its spirit for platform work), [0083](0083-agents-deploy-humans-release.md) (the flag substrate that triggered this), and [0092](0092-gates-fail-closed-on-zero-scope.md) (its sibling — the unconsumed capability and the unfiring gate are the same failure mode at two layers).
