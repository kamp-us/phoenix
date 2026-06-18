---
id: 0083
title: Agents Own Deployment, Humans Own Release — Pipeline Consults `product-development-cycle.md`
status: accepted
date: 2026-06-18
tags: [process, release-engineering, pipeline]
---

# 0083 — Agents Own Deployment, Humans Own Release — Pipeline Consults `product-development-cycle.md`

## Context

The feature-flag substrate (ADR [0081](0081-feature-flag-substrate-cloudflare-flagship.md), Cloudflare Flagship) shipped as epic #488. Flag-gating must become an organic part of the product-development process — a mechanism nobody is required to reach for rots. Two constraints shape how that happens:

1. **The pipeline skills are a distributable plugin** (ADR [0062](0062-repo-as-config-plugin.md), repo-as-config). Foreign repos may have no feature-flag setup, so the skills must not hardcode flags or assume Flagship.
2. **The autonomous pipeline removed the merge-time human eyeball** (the no-eyeball auto-ship model). We want a safety boundary that contains autonomous shipping without reintroducing a per-PR human bottleneck.

## Decision

**Agents own deployment; humans own release.**

1. **The principle.** Agents deploy continuously and autonomously, **contained behind default-off flags** (ship dark). *Release* — flipping the flag so users see the feature — is a deliberate **human** act. In phoenix the flip is the Cloudflare dashboard, which is **infra-admins only**, so release authority equals infra-admins. This **refines the no-eyeball model**: the human checkpoint moves from merge-time to **release-time** — lower-friction (not per-PR) and safer (nothing reaches users without a human flip).

2. **Pipeline skills are cycle-interpreters, not flag-hardcoders.** The skills consult a **repo-owned `product-development-cycle.md`** (a well-known path in the target repo) and follow its prose instructions. This extends ADR [0062](0062-repo-as-config-plugin.md)'s repo-as-config from the *target* to the *process*. If the doc is **absent** — a foreign plugin install — the cycle steps **no-op**, so the plugin stays flag-agnostic and portable.

3. **Phoenix's cycle** is encoded in phoenix's own `product-development-cycle.md`, **not** in the skills: user-facing behavior changes **ship behind a default-off flag by default** (opt out with a stated reason; internal / refactor / infra / docs changes are exempt), gated and retired per `.patterns/feature-flags-*.md`.

4. **Pipeline touchpoints** — how the cycle materializes, at the decision level (exact field/label names are left to the implementing epic):
   - **plan-epic** stamps a per-child containment marker from the cycle rule.
   - **write-code** ships dark.
   - **review-code** verifies the gating (default-off, safe-default, no leak).
   - **ship-it** merges dark — deployment complete, the agent boundary — and **surfaces a release queue** for the humans.
   - **the human flips** the flag (release).
   - **retirement** returns to agents as a drainable chore.

## Consequences

- **Containment by default for autonomous shipping** — a bad auto-merge stays dark until a human releases.
- **Release is a conscious human gate** — infra-admin via the Cloudflare dashboard.
- **Plugin portability is preserved** by the graceful absence of the cycle doc in foreign installs.
- **Flag lifecycle/retirement discipline becomes load-bearing** (per the #513 convention).
- **Non-goals:** automating the flip (release is deliberately human, never an agent step); an in-app release surface, or release authority broader than infra-admins (a possible future — app-RBAC plus a Flagship *Edit* token — explicitly out of scope now).
- **Relates to / refines:** ADR [0081](0081-feature-flag-substrate-cloudflare-flagship.md) (Flagship substrate), [0062](0062-repo-as-config-plugin.md) (repo-as-config), [0053](0053-control-plane-boundary.md)/[0065](0065-gate-critical-skills-are-blocking.md) (control-plane boundary — orthogonal: the flag-gate is a runtime/release-time gate, the control-plane boundary is merge-time; both stand), and the no-eyeball autonomous-shipping model.
