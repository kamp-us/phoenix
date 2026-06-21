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

- **The dominant teardown flake (#1020) is a Cloudflare eventual-consistency
  race, not an alchemy ordering defect.** An initial hypothesis attributed the
  teardown `Conflict` (Cloudflare rejecting an app delete while a worker still
  references it) to a *missing* `worker → FlagshipApp` edge in the persisted
  `downstream` set — i.e. an alchemy delete-ordering bug. A rigorous reproduction
  against the real flagship-binding shape (in the alchemy-effect fork) **disproved
  this**: the FlagshipApp's persisted state correctly carries `downstream:
  ["Worker"]`; `Output.upstreamAny` *does* extract the app FQN from the binding's
  `appId` PropExpr; no cycle-exclusion drops it; and a real deploy→destroy tears
  the worker down **before** the app, cleanly. **Alchemy's delete ordering is
  correct.** The residual `Conflict` is therefore a Cloudflare eventual-consistency
  race: the worker delete is ACKed by CF but not yet propagated when the
  correctly-ordered app delete fires, so CF still sees the reference and rejects.
  When it surfaces, `afterAll(destroy)` **throws** → vitest marks a
  154/154-**green** suite as **failed**. The cleanup step — not the assertions — is
  the failure. There is no alchemy ordering fix to make; the race is handled by
  best-effort teardown (step 1, #1020) and structurally reduced by the shared stage
  (step 7, #1027 — one teardown per run instead of 24).

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

3. **Teardown SUCCEEDS rather than throws.** Alchemy already orders the delete
   worker-before-app correctly (grounded above); the residual `Conflict` is a CF
   eventual-consistency race, not an ordering defect to fix in the dep-fork. It is
   handled by **best-effort teardown** (step 1, #1020 — catch + log + leak) and
   **structurally reduced by the shared stage** (step 7, #1027 — one teardown per
   run instead of 24, far fewer chances to hit the race), backstopped by the orphan
   sweep (#690). A teardown-`Conflict` retry is an optional further hardening, but
   the race is already handled — it is not a blocking fix.

The shared-stage mode and the unit-tier split together turn "we test CF's
create/destroy reliability 24 times a run" into "we deploy once, assert real
behavior, and assert pure logic without a database at all."

## Migration path

Seven incremental, independently-mergeable steps. Each stands alone and lands a
real improvement; the suite is never wedged on an all-or-nothing cutover.

| # | Step | Closes / advances | Notes |
|---|------|-------------------|-------|
| 1 | **Best-effort teardown** — `afterAll(destroy)` catches + logs + leaks instead of throwing | [#1020](https://github.com/kamp-us/phoenix/issues/1020) | Absorbs an **intrinsic CF eventual-consistency race** (the worker delete is ACKed but not propagated when the correctly-ordered app delete fires), not a band-aid over a missing fix — the leaked stages it tolerates are reaped by the #690 sweep (step 6) and the race surface is structurally reduced by the shared stage (step 7). |
| 2 | **DO-readiness warm for `/fate/live`** — warm the LiveDO before asserting the SSE stream | [#1018](https://github.com/kamp-us/phoenix/issues/1018) (503) | Removes the cold-DO 503 on the live route. |
| 3 | **Deploy retry-on-transient** — retry the stage deploy on transient CF errors | [#1019](https://github.com/kamp-us/phoenix/issues/1019) | Absorbs the cross-PR `WorkerNotFound` while still per-file. |
| 4 | **Move ~10 pure-logic files → unit tier** | advances [#771](https://github.com/kamp-us/phoenix/issues/771) | Split conservatively (see Consequences); keep keyset/aggregate residue in the real tier. |
| 5 | **No alchemy ordering fix needed** — a reproduction disproved the ordering hypothesis; the teardown `Conflict` is a CF eventual-consistency race | already mitigated by step 1 ([#1020](https://github.com/kamp-us/phoenix/issues/1020)) + structurally reduced by step 7 ([#1027](https://github.com/kamp-us/phoenix/issues/1027)) | Alchemy orders worker-before-app correctly (grounded above). An optional teardown-`Conflict` retry is the only residual hardening, and the race is already handled. (#813 is a *different* bug — the `deploy.yml` `pr-<n>` CI-cleanup leak — not this.) |
| 6 | **Orphan sweep CLI** — best-effort leak reaper | [#690](https://github.com/kamp-us/phoenix/issues/690) | Reaps the stages step 1 leaks on a teardown-race `Conflict`; the Effect-CLI idiom (CLAUDE.md). |
| 7 | **Run-scoped shared-stage harness mode** — deploy once per run, namespace-isolated | roots [#1010](https://github.com/kamp-us/phoenix/issues/1010) / [#1019](https://github.com/kamp-us/phoenix/issues/1019) / [#1020](https://github.com/kamp-us/phoenix/issues/1020) | Composes with [#684](https://github.com/kamp-us/phoenix/issues/684) (sharding) and [#958](https://github.com/kamp-us/phoenix/issues/958) (`isolate:false`). |

## Consequences

- **Best-effort teardown (step 1) tolerates a leaked stage so a green suite stays
  green.** The teardown `Conflict` is a CF eventual-consistency race, not an
  alchemy ordering bug a dep-fork patch could eliminate (a reproduction disproved
  that hypothesis — see Grounded facts). So step 1 is not a band-aid over a missing
  fix: it absorbs an intrinsic platform race, and the shared stage (step 7)
  structurally reduces how often that race can fire (one teardown per run instead
  of 24). The orphan sweep (#690) reaps whatever step 1 leaks. An optional
  teardown-`Conflict` retry could tighten this further, but is not required.
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
this rests on), and [0032](0032-alchemy-beta45-and-dev-model.md) (alchemy binds
remote D1 in dev).

Extends [0082](0082-two-test-tiers-unit-integration.md): its two-tier *names*
(`unit` / `integration`) and its ban on faked SQL engines stand unchanged; only
its **per-file-stage shape** for the `integration` tier is superseded — replaced
by the run-scoped shared stage for the irreducible files and a downward move of
pure-logic files to the `unit` tier.
