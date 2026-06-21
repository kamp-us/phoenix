---
id: 0104
title: Two-Mode Integration Test Tier — a Run-Scoped Shared Stage for Real-D1/DO Files, the Unit Tier for Pure Logic
status: accepted
date: 2026-06-20
tags: [testing, architecture, alchemy, d1, ci, flake]
---

# 0104 — Two-Mode Integration Test Tier: a Run-Scoped Shared Stage for Real-D1/DO Files, the Unit Tier for Pure Logic

## Context

Extends [0082](0082-two-test-tiers-unit-integration.md).

ADR 0082 collapsed the test taxonomy to two tiers — `unit` (no DB) and
`integration` (real remote D1 via the alchemy `Test.make` idiom) — and shaped the
`integration` tier as **per-file isolated stages**: each test file runs
`beforeAll(deploy(Stack))` / `afterAll(destroy(Stack))`, so every file deploys its
own ephemeral **real-Cloudflare** stage (worker + D1 + DOs + FlagshipApp) and
asserts black-box over HTTP/SSE. With ~24 integration files, that is **~24
ephemeral real stages provisioned and torn down per run**.

This produced a persistent flake saga: `WorkerNotFound` (10007),
Conflict-on-teardown, no-versions, and `/fate/live` 503/500. The investigation
behind the flake inventory established the shape of the problem — and the shape is
not "real D1 is flaky," it is a **fidelity / cost mismatch**:

- We run **one uniform tier at the most expensive fidelity** (a real per-file
  Cloudflare deploy) to assert things that are **mostly pure logic**. Of the ~24
  files, **~10 are pure-logic-dominant** (need no real CF — they exercise
  resolver/normalization/envelope/routing logic a `Layer.succeed(Drizzle, …)`
  unit test already covers), **~12 are irreducibly real-D1/DO** (keyset
  execution, FTS5, batch atomicity, the DO + SSE composite), and **2 are
  over-provisioned**.
- So **~42% of every run pays full CF provisioning + teardown cost** — and, worse,
  inadvertently tests **Cloudflare's create/destroy reliability** — to exercise
  logic that never needed a database to be wrong.
- Every flake class is **proportional to the 24× create/destroy surface**: the
  within-run create storm ([#1010](https://github.com/kamp-us/phoenix/issues/1010)),
  the cross-PR `WorkerNotFound` ([#1019](https://github.com/kamp-us/phoenix/issues/1019)),
  and the teardown-`Conflict`-fails-a-green-suite class
  ([#1020](https://github.com/kamp-us/phoenix/issues/1020)) all scale with the
  number of stages we stand up and tear down.

### Grounded facts (verified against source, not assumed)

The 0040 → 0082 lineage exists *because* a load-bearing platform claim was
asserted from intuition and was wrong (`node:sqlite` is **not** the same engine as
D1; see [0040](0040-testing-taxonomy-and-seam-graduation.md)). This ADR keeps that
discipline — every platform claim below is grounded in the alchemy-effect fork's
source or in CI's own observed behavior, per CLAUDE.md's "ground falsifiable
claims" rule.

- **There is no faithful local D1; a "local-workerd tier" is a dead end for D1.**
  In the alchemy-effect fork, the local worker provider
  (`packages/alchemy/src/.../Cloudflare/Workers/LocalWorkerProvider.ts`, in the
  `D1` binding branch) returns `D1.remote(...)` — alchemy binds the **real remote**
  D1 even in `ALCHEMY_DEV` / local-workerd mode. There is **no local D1
  emulation** anywhere in the stack. Durable Objects *do* run locally
  (`DurableObjectNamespace.local`), but D1 does not. **Consequence:** pure-logic
  files do **not** move to a new local-workerd tier — local D1 isn't faithful, so
  a workerd tier would re-commit the 0040 `node:sqlite`≠D1 sin in a new costume.
  They move to the **existing unit tier** (the `Drizzle` layer seam). This is the
  0040 ghost, still load-bearing.

- **The dominant teardown flake (#1020) is a missing persisted dependency edge.**
  In alchemy-effect, a delete node waits for its persisted `downstream` set to
  delete first (the delete-ordering loop in `packages/alchemy/src/.../Apply.ts`);
  that `downstream` set is written at **deploy** time by `computeDownstream`
  (`packages/alchemy/src/.../Plan.ts`). The `worker → FlagshipApp` binding edge is
  **not landing** in the persisted `downstream`, so on teardown the worker and the
  app delete **concurrently** → Cloudflare rejects deleting a FlagshipApp still
  referenced by a live worker → `afterAll(destroy)` **throws** → vitest marks a
  154/154-**green** suite as **failed**. The cleanup step is failing the
  assertions. This is durable-fixable upstream (see step 5).

- **The one-stage model is already proven in CI.** The e2e job in
  `.github/workflows/ci.yml` does exactly **one** preview deploy and lets
  Playwright assert against it — reliably green — versus the integration tier's
  ~24 deploys. The expensive part is the **per-file** multiplication, not the real
  deploy itself.

The net reading: 0082's per-file-stage shape was the right *fidelity floor* for
the irreducible files but the wrong *cost model* for the suite. We pay 24× a price
that buys real value for ~12 files, buys nothing for ~10, and manufactures three
flake classes for all of them.

## Decision

**The `integration` tier becomes two-mode**, extending 0082's per-file-stage model
(see the supersession note below):

1. **A run-scoped SHARED stage.** Deploy **once per run** (namespace-isolated per
   run), hosting the **~12 irreducible real-D1/DO files**. This collapses the
   create/destroy surface from **24 → 1**, rooting out the storm (#1010), the
   cross-PR `WorkerNotFound` (#1019), and the teardown-`Conflict` class (#1020) at
   their common cause: the count of stages we stand up and tear down.

2. **Pure-logic files move down to the EXISTING unit tier.** The ~10
   pure-logic-dominant files' assertions move to the `unit` tier (the `Drizzle`
   layer seam), **not a new tier** — because local D1 is not faithful (grounded
   above), a workerd tier is not an option. This is the 0082 litmus applied
   per-file: *"could this be wrong even if the database behaved perfectly?"* —
   yes → unit.

3. **Teardown SUCCEEDS rather than throws.** The durable fix is the alchemy-effect
   `downstream`-ordering correction (step 5) so `destroy` orders worker-before-app
   and completes cleanly. Near-term it is **backstopped by best-effort teardown**
   (catch + log + leak) plus the orphan sweep (#690). The end state is a teardown
   that cleans up; the interim tolerates a leak rather than reddening a green
   suite.

The shared-stage mode and the unit-tier split together turn "we test CF's
create/destroy reliability 24 times a run" into "we deploy once, assert real
behavior, and assert pure logic without a database at all."

## Migration path

Seven incremental, independently-mergeable steps. Each stands alone and lands a
real improvement; the suite is never wedged on an all-or-nothing cutover.

| # | Step | Closes / advances | Notes |
|---|------|-------------------|-------|
| 1 | **Best-effort teardown** — `afterAll(destroy)` catches + logs + leaks instead of throwing | [#1020](https://github.com/kamp-us/phoenix/issues/1020) *(in flight)* | A **mitigation**, not the fix — tolerates leaks until 5 + 6 land; must not become permanent (see Consequences). |
| 2 | **DO-readiness warm for `/fate/live`** — warm the LiveDO before asserting the SSE stream | [#1018](https://github.com/kamp-us/phoenix/issues/1018) (503) | Removes the cold-DO 503 on the live route. |
| 3 | **Deploy retry-on-transient** — retry the stage deploy on transient CF errors | [#1019](https://github.com/kamp-us/phoenix/issues/1019) | Absorbs the cross-PR `WorkerNotFound` while still per-file. |
| 4 | **Move ~10 pure-logic files → unit tier** | advances [#771](https://github.com/kamp-us/phoenix/issues/771) | Split conservatively (see Consequences); keep keyset/aggregate residue in the real tier. |
| 5 | **Durable `downstream`-ordering fix** in the alchemy-effect dep-fork | [#813](https://github.com/kamp-us/phoenix/issues/813) | The real fix for #1020 — orders worker-before-app delete; a local-only dep patch per ADR [0038](0038-dependency-patches-local-only.md). |
| 6 | **Orphan sweep CLI** — best-effort leak reaper | [#690](https://github.com/kamp-us/phoenix/issues/690) | Backstops step 1's tolerated leaks until 5 lands; the Effect-CLI idiom (CLAUDE.md). |
| 7 | **Run-scoped shared-stage harness mode** — deploy once per run, namespace-isolated | roots [#1010](https://github.com/kamp-us/phoenix/issues/1010) / [#1019](https://github.com/kamp-us/phoenix/issues/1019) / [#1020](https://github.com/kamp-us/phoenix/issues/1020) | Composes with [#684](https://github.com/kamp-us/phoenix/issues/684) (sharding) and [#958](https://github.com/kamp-us/phoenix/issues/958) (`isolate:false`). |

## Consequences

- **Best-effort teardown (step 1) is a mitigation, not the fix — and must not
  become permanent.** It tolerates a leaked stage so a green suite stays green,
  but a tolerated leak is exactly the kind of band-aid CLAUDE.md's root-cause rule
  forbids leaving in place. Steps 5 (durable ordering fix) and 6 (sweep) are the
  fix; step 1 must be *removed* once they land, not left as the steady state.
- **The shared stage (step 7) risks cross-file row bleed.** Files that touch a
  **global aggregate** — `stats` landing counters, karma totals — cannot be
  namespace-isolated by a per-file slug the way per-row content can, because the
  aggregate is global by construction. Those files **stay per-file** *or* assert
  **within-stage deltas** (before/after counts) rather than absolute totals.
  Validate **per file** before moving it onto the shared stage; do not assume the
  slug namespace covers it.
- **Step 4 risks mis-tagging a file as pure-logic.** A file that *looks* like
  resolver logic may secretly lean on a D1 semantic (a collation tiebreak, a
  keyset edge, an FTS5 fold). **Split conservatively**: when in doubt, the file
  stays in the real tier. Keyset and aggregate residue belong on real D1 — moving
  them to unit would re-introduce the 0040 false-confidence failure (asserting a
  DB-dependent fact against no DB).
- **Wall-clock and CF surface drop sharply.** Step 7 takes the integration tier
  from ~24 real deploys/run to **1**; step 4 removes ~10 files from the real tier
  entirely. The dominant flake classes (#1010/#1019/#1020) are proportional to the
  create/destroy count, so collapsing the count is what closes them — not more
  retries.
- **The irreducible real-D1/DO core is preserved at full fidelity.** Batch
  atomicity, idempotency on composite-PK conflict, keyset *execution* (collation /
  NULL / date / string tiebreaks), FTS5 bm25/prefix/MATCH, read-row shaping +
  aggregate counters, the better-auth session round-trip, and the DO + SSE
  composite all stay on **real remote D1** (the 0082 irreducible core), now on one
  shared stage instead of N ephemeral ones.

Builds on [0082](0082-two-test-tiers-unit-integration.md),
[0040](0040-testing-taxonomy-and-seam-graduation.md) (the `node:sqlite`≠D1 lesson
this rests on), [0032](0032-alchemy-beta45-and-dev-model.md) (alchemy binds remote
D1 in dev), and [0038](0038-dependency-patches-local-only.md) (the dep-fork patch
path for step 5).

Extends [0082](0082-two-test-tiers-unit-integration.md): its two-tier *names*
(`unit` / `integration`) and its ban on faked SQL engines stand unchanged; only
its **per-file-stage shape** for the `integration` tier is superseded — replaced
by the run-scoped shared stage for the irreducible files and a downward move of
pure-logic files to the `unit` tier.
