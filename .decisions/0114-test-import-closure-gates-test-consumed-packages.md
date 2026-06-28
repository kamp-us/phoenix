---
id: 0114
title: Gate Worker-Irrelevant-but-Test-Consumed `packages/**` via a Computed Test-Import Closure in `@kampus/worker-relevance`
status: accepted
date: 2026-06-28
tags: [ci, testing, worker-relevance, integration, gating]
---

# 0114 — Gate Worker-Irrelevant-but-Test-Consumed `packages/**` via a Computed Test-Import Closure in `@kampus/worker-relevance`

## Context

Amends [0104](0104-two-mode-integration-test-tier.md) and
[0082](0082-two-test-tiers-unit-integration.md) (the two-mode / two-tier
integration design) and the `@kampus/worker-relevance` classifier (#1014, serving
the #994 skip optimization). It records the gating decision the design gap in
**#1389** demands.

There is a hole in CI's integration-tier gating. A change to a `packages/**`
package the **worker** never imports but an **integration/e2e test** consumes can
merge GREEN and plant a runtime regression that detonates on the next innocent PR —
the integration tier, the only gate that would catch it, is skipped for exactly the
PR that introduces the break.

Two CI mechanisms align to skip it, both in `.github/workflows/ci.yml`:

1. **The `backend` path filter** (`changes` job's `dorny/paths-filter` `backend:`
   list) enumerates `apps/web/worker/**`, `apps/web/tests/integration/**`, a fixed
   handful of `apps/web` config files, and exactly two packages —
   `packages/preview-seed/**` and `packages/moderator-grant/**` — plus
   `pnpm-lock.yaml` and the workflow file. A change confined to
   `packages/founder-seed/**` matches **none** of these, so `backend` is `false`.
2. **The `worker-relevance` classifier** backstops the lockfile case: when such a
   PR also edits `pnpm-lock.yaml` (tripping `backend`), the classifier attributes
   the lockfile delta and emits `worker_relevant=false`, because its import closure
   is exactly `{db-schema, fate-effect}` plus `preview-seed` and `moderator-grant`
   (per `packages/worker-relevance/README.md`). **The classifier's graph keys on
   worker imports, not test imports** — so it cannot see the
   `apps/web/tests/integration/kunye-moderate-seam.test.ts → @kampus/founder-seed`
   edge.

These feed `integration_required`: `(backend == 'true' || feature-complete) &&
worker_relevant != 'false' && <guard>`. For a founder-seed-only PR both the
`backend` and `worker_relevant` clauses resolve to skip, `integration_required`
is `false`, the `integration` job's `if:` is false → the job does not run, and
`ci-required` treats a `required == false` skip as a legitimate PASS (ADR
[0092](0092-gates-fail-closed-on-zero-scope.md)). CI goes green with the contract
break merged.

No other required gate catches it. `check` (lint/format/typecheck) catches a
**type-incompatible** change, but the hole is a **type-compatible,
runtime/behavioral** break — the test still compiles, only its execution diverges.
`unit` does not run the creds-gated integration tests. `packages-tests` runs each
package's **own** suite, not `apps/web/tests/integration/**`. So a type-compatible
runtime contract break in a worker-irrelevant, test-consumed package trips **no
required gate**.

This is exactly what **#1352** was: a founder-seed (#1207) PR that changed the
`seedFounders` contract, merged GREEN, and broke
`kunye-moderate-seam.test.ts` — the red surfaced on innocent downstream PRs
**#1378 / #1380**, blocking the **#1383** p0 (fixed via merged **#1385**). The root
cause is precise: **`packages/founder-seed` was simply not on a hand-maintained
list** of integration-relevant packages, and nothing computed the fact that a test
imports it.

The question this ADR settles: **how should CI gate a change to a `packages/**`
package the worker doesn't import but an integration/e2e test does — without making
every PR pay the CF-cred integration cost the #994/#1014 skip optimization was built
to avoid?**

## Decision

**Teach `@kampus/worker-relevance` a second closure — the test-import closure — and
treat a change to any of its members as integration-relevant.**

The test-import closure is the set of `packages/**` packages imported under
`apps/web/tests/integration/**` and `apps/web/tests/e2e/**`, **computed from the
real imports** in those test files (not a maintained list). The classifier already
owns a worker-import closure (`{db-schema, fate-effect, preview-seed,
moderator-grant}`); this adds a parallel closure derived from what the integration
and e2e test trees actually import, and the relevance check becomes the **union**:
a `packages/**` change is integration-relevant if the package is in the worker
closure **or** in the test-import closure. A change to any test-imported member
forces `integration_required == 'true'`, so the integration tier runs on the
**introducing** PR — where the break is caught — not on the next innocent one.

### Rationale (CF-cost vs coverage vs drift-resistance)

- **Drift-resistance — the deciding property.** The closure is **computed from real
  imports**, so it **cannot drift**. The root cause of #1352 was that
  `founder-seed` was simply absent from a hand-maintained list; a closure derived
  from the actual `import` graph adds a newly test-imported package to the relevant
  set the moment a test imports it, with no human edit and no window where a new
  edge is silently uncovered. The thing that broke is structurally removed, not
  patched.
- **Coverage.** It is the most precise of the three forks: it makes integration
  run for *exactly* the test-consumed packages and no others, closing the
  type-compatible-runtime-break hole at its source (the missed test-import edge).
- **CF-cost — the skip optimization is preserved.** A genuinely-isolated package —
  one no integration/e2e test imports and the worker doesn't import — is in
  **neither** closure, so its change stays integration-skipped and pays **no**
  CF-cred cost. A docs-/tooling-only or isolated-package-only PR still skips the
  tier exactly as #994/#1014 intended (see Consequences). The cost is paid only by
  PRs that touch a package an integration/e2e test actually exercises — which is
  precisely the set that needs the tier.
- **Cost of the mechanism.** A real classifier extension: compute the test-import
  set by parsing the imports under the two test trees and resolving `@kampus/*`
  specifiers to `packages/**` members, keeping `@kampus/worker-relevance`'s
  pure-core + thin-bin, zero-runtime-dependency shape so the `changes` step runs it
  without `pnpm install`.

### Why the alternatives were rejected

- **(b) Path-filter widening — rejected.** Add the integration-test-consumed
  packages (today `packages/founder-seed/**`) to the `backend`/`e2e` filter lists,
  the way `preview-seed`/`moderator-grant` already are. Cheapest, but it is a
  **hand-maintained list that recreates this exact failure mode**: it rots the
  moment a test imports a new package and nobody edits `ci.yml`. Choosing it would
  re-plant the precise root cause of #1352 (a package missing from a list), so it
  fails the one property that matters most here — drift-resistance.
- **(c) Lighter edge-flag — rejected.** A guard that only *flags* (warns /
  fails-closed on a diff) the test-import edge without running the tier, deferring
  the run decision. Rejected because it **does not guarantee the break is caught
  pre-merge**: a warning the merge can proceed past leaves the same green-merge /
  downstream-red shift in place. The decision is to make the gate *run*, not to
  surface an advisory the autonomous lane can sail past.

### Amendment relationship

This ADR **amends** the worker-relevance design (#1014) by adding a second closure
alongside its worker-import closure — the classifier's relevance verdict is now the
union of two closures, not one. It **amends** the integration-tier gating of ADRs
[0082](0082-two-test-tiers-unit-integration.md) and
[0104](0104-two-mode-integration-test-tier.md) only in *what makes a PR
integration-relevant* — the tier's **shape** (the run-scoped shared stage of 0104,
the real-D1 irreducible core of 0082) is **unchanged**. The fail-safe-to-running
invariant (#1014, ADR 0092: when unsure, RUN) stands; this strictly *widens* the
set that runs, never narrows it.

### Control-plane disposition

The implementing PR edits `@kampus/worker-relevance` and/or
`.github/workflows/ci.yml` — **control-plane** surface (ADR
[0053](0053-control-plane-boundary.md)) → **human merge**, never
auto-ship, even on green CI. It is filed as **#1450** (`status:needs-triage`); this
ADR records the decision, and the implementation routes through triage and a human
merge per ADR 0053.

## Consequences

- **The hole closes at its source.** A type-compatible runtime contract break in a
  worker-irrelevant, integration/e2e-test-consumed package now forces the
  integration tier on the introducing PR. The #1352 → #1378/#1380 → #1383 incident
  class — green merge, downstream red on an innocent PR — cannot recur for a
  test-imported package.
- **The test-consumed-package set stays correct over time by construction.**
  Because the closure is computed from the real imports under
  `apps/web/tests/integration/**` and `apps/web/tests/e2e/**`, it has **no list to
  maintain** and **no silent-drift window**: a package becomes relevant the instant
  a test imports it and stops being relevant when the last test import is removed.
  This is the explicit answer to "how does the set stay correct" — a computed
  closure, not a maintained list, so the guard against drift is the computation
  itself.
- **The #994/#1014 skip optimization is preserved for genuinely-isolated
  packages.** A `packages/**` package in neither closure (no worker import, no
  integration/e2e test import) still skips the integration/e2e tiers, so a
  docs-/tooling-only or isolated-package-only PR pays no CF-cred cost — the
  optimization's whole purpose. Only packages an integration/e2e test actually
  exercises now pull the tier, which is the minimal set that must.
- **CF-cred cost rises only for genuinely test-exercised packages.** The added
  integration runs are confined to PRs touching a package the integration/e2e suite
  imports — by definition the PRs whose change the tier needs to validate — so the
  cost increase is proportional to real coverage need, not a blanket
  always-run regression.
- **The classifier gains a parsing surface to keep honest.** Computing the closure
  means parsing test-tree imports and resolving `@kampus/*` → `packages/**`. Per
  the fail-safe-to-running invariant, a parse failure or ambiguity must resolve to
  RUN (relevant), never to a silent skip — the extension inherits #1014's
  when-unsure-run posture.

Implementation tracked in **#1450** (control-plane → human merge, ADR 0053).
