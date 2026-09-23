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

> Amendment 2026-08-19: the tenant's artifact set moved. `kampus-pipeline` (the plugin) is retired, `pipeline-crew` / `pipeline-crew-mcp` are gone (ADRs [0303](0303-retire-kampus-pipeline-plugin.md), [0279](0279-v1-crew-retired-in-full.md)), and `packages/pipeline-cli/` was deleted by PR #6326; the live set is `claude-plugins/fabrika` + `packages/fabrika-cli`. The release-tag grammar in Decision 4 now covers `fabrika-cli-v*` in place of `pipeline-cli-v*` — see `.github/workflows/publish.yml`. Tenancy, phoenix-first priority, and publish isolation stand unchanged.

## Amendment (2026-09-23, [#9740](https://github.com/kamp-us/phoenix/issues/9740)) — a published package may link a published sibling with `workspace:`

Founder ruling: <https://github.com/kamp-us/phoenix/issues/9740#issuecomment-5803759118>.

Seven Tuval packages now publish beside the fabrika pair (`@kampus/design`, `@kampus/tuval-sdk`,
`@kampus/tuval-ui` and the four harness packages), and they depend on each other with
`workspace:*`. Decision 3 still holds: a published artifact installs from a clean registry. What
changes is how the guard reads a `workspace:` link.

1. **A `workspace:` runtime dep on a package in the published set passes.** `publish.yml`
   publishes with `pnpm publish`, which rewrites `workspace:` to the sibling's in-repo version at
   pack time, so the tarball names a registry version. Each Tuval package's
   `public-surface.pack.test.ts` asserts no packed range starts with `workspace:`.
2. **A `workspace:` runtime dep on a package outside the published set still reds.** That is the
   #3802 class this record was written against: the rewritten version exists on no registry.
   A pinned `@kampus/*` dep that is not published still reds as before.
3. **Release order: a dependency publishes before its dependents.** The packed range pins the
   sibling's in-repo version, which may not be on npm yet. So `tuval-sdk` and `design` release
   first, then `tuval-ui`, then the harness packages. The guard does not check this. The order is
   the order a human merges the per-package Release PRs in, and `release-please.yml` dispatches
   the publishes of one push in that order. A dependent published early installs once the
   sibling's version lands, because npm resolves the pinned version when it appears.
