---
id: 0040
title: Testing Taxonomy and Test-Seam Graduation
status: accepted
date: 2026-06-07
tags: [testing, framework, architecture]
---

# 0040 — Testing Taxonomy and Test-Seam Graduation

## Context

phoenix is both a framework and its first application (organic framework
evolution): testing primitives are born in-app, then graduate. Yet testing
convention was never codified — [0010](0010-effect-context-service-backend.md)
and [0029](0029-worker-runtime-servicemap.md) define the service/layer
architecture, [0011](0011-drizzle-context-service.md) /
[0014](0014-drizzle-run-batch-as-service-methods.md) the `Drizzle` seam, but
none say what a *test* is, where it runs, or what backs it.

The gap produced two concrete pathologies:

- **Mislabeled tiers.** `apps/web/vitest.config.ts` has two projects, `unit`
  and `integration`. The `unit` project (glob `worker/**/*.test.ts`) is
  misnamed: the moment a test calls `makeSqliteD1()` it has booted a real
  `node:sqlite` engine and run the real `0000_d1_baseline.sql` migration. That
  is sociable integration, not a unit test.
- **Domain assertions in the wrong tier.** The `integration` project deploys
  the real alchemy stack on local workerd and asserts black-box over HTTP
  against **real remote Cloudflare D1** — the alchemy 2.0 / Effect rewrite
  (`alchemy-run/alchemy-effect`) dropped Miniflare and has no offline local D1
  (see [0032](0032-alchemy-beta45-and-dev-model.md)). Keyset-ordering
  correctness (`popular-sort`, `sozluk-read`) was filed there, paying remote-D1
  latency and seed-ordering races to test what is deterministic SQL. That is
  the flake source.

The deep reason both happened: a tier was treated as a *folder* rather than as
*which layer satisfies a fixed R-channel*.

## Decision

**Tiers are choices of layer satisfying a fixed R-channel. The tier boundary is
where the layer algebra runs out — the workerd process boundary.** In-process
tiers are reachable by `Effect.provide`; the deployed stack over remote D1 is a
*different* algebra (stack-deploy) with no R-channel to provide to. T3 is an
HTTP URL to a separately-deployed worker, not a layer.

**Fixed definitions:**

- **unit** = pure logic, no SQL engine, no I/O. If it boots `node:sqlite` it is
  not a unit test.
- **integration** = real feature services over a real in-memory SQL engine
  (`node:sqlite` behind the D1 surface) + real migrations, one Node process, no
  workerd.
- **system** = the deployed alchemy stack on local workerd, asserted black-box
  over HTTP against real remote D1.

**Four-tier taxonomy:**

| Tier | Definition | Backed by | Examples |
|------|-----------|-----------|----------|
| **T0 — unit (pure)** | Pure fns / Effect logic, zero storage | none (`it.effect`) | keyset codec, hot-score arithmetic, `encodeFateError` |
| **T1 — service-integration** | Real feature service over real SQL; only the `Database` layer swaps | `node:sqlite` `:memory:` (`sqlite-d1.testing.ts`) + real `0000_d1_baseline.sql` | `Vote.test.ts`, `Drizzle.test.ts` |
| **T2 — bridge/app-integration** | Full `FateEnv` (minus per-request trio) through `fateServer.handleRequest`; wire codes, topic publishes, real-or-stubbed better-auth | `node:sqlite` under the worker layer, no workerd | `bridge-sozluk.test.ts`, `bridge-products.test.ts` (renamed to `sozluk.test.ts` / `products.test.ts`, PR #67), `app.test.ts` |
| **T3 — system (stack-smoke, NOT a layer)** | Black-box HTTP over deployed workerd; no R-channel | **real remote D1** + workerd | `seam.test.ts`, `fate-live.test.ts` |

T1 and T2 stay distinct because they swap *different* layers: T1 swaps only the
`Database` seam (and through it `Drizzle`); T2 also crosses the wire-encoding
boundary and varies the auth layer. `app.test.ts` is T2 with a real auth layer,
not its own tier.

**One `Database` seam; both surfaces derive from it.** A `Database` tag holds
the raw `D1Database` handle — the single seam (`apps/web/worker/db/Database.ts`).
Both downstream surfaces *derive* from it: the `Drizzle` service is built from
`Database` (via `createDrizzle`), and the better-auth adapter is built from
`Database`. Because both derive from the **same** tag, they are guaranteed to
share one underlying handle — the one-`sqlite` invariant is **type-enforced by
the layer graph**, not upheld by hand in each test. The trio is therefore
genuinely layer-swappable: provide one `Database` layer and both `Drizzle` and
auth rebind. `makeFateLayer` is a zero-arg layer (`R = Database | BetterAuth`);
a test (or any consumer) provides one `Database` layer over the `node:sqlite`
fake and the whole `FateEnv` follows.

**Fidelity boundary.** `node:sqlite` is the same engine as D1 — keyset order
(BINARY collation), `ON CONFLICT`, `COUNT(*)`, soft-delete filters are
hermetically faithful, so **domain correctness belongs in T1/T2**. Genuine
real-D1-only divergences, reserved for T3 (or a binding-level micro-tier):

1. batch meta-envelope (`changes` / `last_row_id`),
2. `foreign_keys` default (raw `node:sqlite` defaults ON, D1 defaults OFF),
3. D1 `changes` / `last_row_id` / statement-index-on-batch-error,
4. the DO + SSE + D1 composite (`fate-live.test.ts`).

Divergences #1/#3 (batch-meta) are **resolved on this branch**: the d1 fake
populates D1's `meta` envelope from `node:sqlite`'s `StatementSync.run()`
(`changes` / `last_row_id`, per-statement on `batch()`), and a binding-level
micro-tier asserts that contract in-process — `sqlite-d1.testing.test.ts`
exercises the raw `prepare(...).run()` / `batch([...])` surface, since `meta` is
a property of that binding contract, not of Drizzle. The previous recorded gap
("batch-meta untested at every tier") is closed; do not re-file it. Divergence
#2 is reconciled in the test helper: `makeSqliteTestDb()` forces
`PRAGMA foreign_keys=OFF` to match D1's default. Statement-index-on-batch-error
and the live composite (#4) remain T3/real-D1 territory.

**Test-seam graduation rule (organic evolution):**

- **Gate A — rule-of-three → extract an app-local factory.** At ≥3 in-app call
  sites, extract a *factory* (fresh per call; never a shared mock layer
  instance — see `.patterns/effect-testing.md`). Home stays app-local under
  `worker/`, not `packages/`.
- **Gate B — graduate to a package / upstream.** Requires proven-in-app **and**
  a second consumer or an upstream home. An empty `packages/` is load-bearing
  signal that nothing has earned graduation. Only the alchemy+vitest
  deploy-orchestration sliver can ever graduate upstream (to
  `usirin/alchemy-effect`, per [0038](0038-dependency-patches-local-only.md)),
  and only after the `seedTerm`/better-auth coupling is cut.

## Alternatives considered

**Pass concrete `db` + `auth` handles into `makeFateLayer`.** The first draft
held that `makeFateLayer(db, auth)` *had* to take concrete handles and was
**not** cleanly layer-swappable, because better-auth is constructed off the raw
`d1`, and a `Layer<Drizzle>` swap would hand features and auth two different
in-memory SQLites. That premise conflated "one shared handle" with "passed as a
concrete argument." The `Database` tag dissolves it: deriving both `Drizzle` and
the auth adapter from one tag gives the shared-handle guarantee *by
construction*, so no caller threads two handles and none can accidentally split
features and auth onto two SQLites. The seam became swappable and the layer
zero-arg.

## Consequences

- The `unit` Vitest project must be re-tiered. Do it atomically across
  `vitest.config.ts` + `package.json` scripts + CI, **or** introduce T0 as a
  `*.unit.test.ts` naming convention inside the existing project — the latter
  avoids a third Vitest project, which would re-trigger Vitest 4's distinct-
  `sequence.groupOrder` rule (the two projects today are `groupOrder` 0/1 with
  differing `maxWorkers`). Convention-first is preferred.
- Domain-correctness assertions move from T3 down to T1/T2. This is a **fixture
  rewrite, not a relocation**: seed by direct INSERT, not by N HTTP voter
  sign-ups (the former flake engine in `sozluk-read`).
- `makeFateLayer` is a **zero-arg layer** (`R = Database | BetterAuth`): the raw
  handle lives behind the `Database` tag and both surfaces derive from it, so the
  single-`sqlite` guarantee is enforced by construction rather than owned by
  tests. `createDrizzle` stays exported for the auth adapter (both build off the
  same raw handle from `Database`).
- The test kit is **built and pattern-doc'd** (`.patterns/effect-testing.md`):
  `makeSqliteTestDb()` (baseline migration applied, `PRAGMA foreign_keys=OFF`
  baked in) and `runFateOp()` (driving one fate operation through the bridge,
  owning the single-`provide` contract). These are API shapes, so their home is
  `.patterns/`, not this decision.
- Banned: calling a test that boots `node:sqlite` a "unit" test; filing
  deterministic-SQL correctness assertions in T3.

Builds on [0011](0011-drizzle-context-service.md),
[0014](0014-drizzle-run-batch-as-service-methods.md),
[0029](0029-worker-runtime-servicemap.md),
[0032](0032-alchemy-beta45-and-dev-model.md), and
[0038](0038-dependency-patches-local-only.md).
