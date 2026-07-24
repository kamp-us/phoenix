---
id: 0201
title: The pipeline is a product, but phoenix is its home — tenant model with isolated
  publishing, and phoenix-first priority as a standing guardrail
status: accepted
date: 2026-07-24
tags: [pipeline, pipeline-crew, distribution, publishing, governance]
---

# 0201 — Pipeline-as-product stays a phoenix tenant; phoenix-first is the priority law

**What this decides:** the agent pipeline (kampus-pipeline + pipeline-crew plugins,
pipeline-cli, pipeline-crew-mcp) is a product with external consumers — and it is
deliberately NOT extracted to its own repo. It lives in phoenix as a tenant with an
isolated publishing pipeline, and phoenix's own product needs always outrank external
pipeline demand.

## Context

External demand to run the pipeline on other repos is real (first concrete consumer:
the control-plane approver's own repos), which forces the distribution question. The
obvious shape — extract to a dedicated repo — was considered and rejected by the
founder (2026-07-24, conversation-authored per ADR 0075).

The forcing evidence for "isolated publishing" is fresh: `pipeline-cli@0.2.0`
published successfully yet was uninstallable, because it declared three
phoenix-private `workspace:*` packages as registry deps (#3802, fixed by inlining in
#3805). The published artifact silently depended on the phoenix workspace it lives
in. That is precisely the entanglement this ADR names and turns into an enforced
invariant instead of a hope.

## Decision

1. **Tenant, not extraction.** The pipeline packages stay in the phoenix monorepo.
   Phoenix is the pipeline's permanent proving ground: every capability is
   battle-tested against real product work before any external consumer sees it.
   Dogfooding is the QA; extraction would replace real stakes with toy problems.
2. **Phoenix-first priority guardrail.** External pipeline demand (features, compat,
   support) never outranks phoenix's own product needs. The pipeline improves BY
   building phoenix; external use rides downstream and never reprioritizes it.
3. **Isolated publishing = decoupled dependency graph, not relocated code.** Every
   *published* pipeline artifact must be self-contained: zero phoenix-private deps,
   installable from a clean registry state into any repo. Enforced by a fail-closed
   CI guard (see consequences), not by review vigilance.
4. **Independent release cadence.** Pipeline artifacts version and release on their
   own tags (`pipeline-cli-v*` etc., `publish.yml` OIDC), decoupled from phoenix app
   deploys.

## Consequences

- A publish-isolation guard becomes required CI: any published pipeline package
  declaring a private/unpublished `@kampus/*` dep reds the build (the #3802 class
  becomes unrepresentable). This is the first deliverable of the pipeline
  productization campaign.
- `pipeline-crew-mcp` needs a distribution unit for external repos (#3366 —
  marketplace-bundled and/or npm); its dependency set is already clean (`effect`,
  `@effect/platform-node`, `proper-lockfile` — no `@kampus/*`).
- Future "should we extract it" proposals must overturn this ADR explicitly rather
  than re-litigate silently.
- Support and feature asks from external consumers enter the same intake as
  everything else and are prioritized under the phoenix-first rule.
