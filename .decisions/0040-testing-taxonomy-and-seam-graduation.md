---
id: 0040
title: Testing Taxonomy and Test-Seam Graduation
status: accepted
date: 2026-06-06
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
| **T1 — service-integration** | Real feature service over real SQL; only the `Drizzle` layer swaps | `node:sqlite` `:memory:` (`sqlite-d1.fake.ts`) + real `0000_d1_baseline.sql` | `Vote.test.ts`, `Drizzle.test.ts` |
| **T2 — bridge/app-integration** | Full `FateEnv` (minus per-request trio) through `fateServer.handleRequest`; wire codes, topic publishes, real-or-stubbed better-auth | `node:sqlite` under the worker layer, no workerd | `bridge-sozluk.test.ts`, `bridge-products.test.ts`, `app.test.ts` |
| **T3 — system (stack-smoke, NOT a layer)** | Black-box HTTP over deployed workerd; no R-channel | **real remote D1** + workerd | `seam.test.ts`, `fate-live.test.ts` |

T1 and T2 stay distinct because they swap *different* layers: T1 swaps only
`Drizzle`; T2 also crosses the wire-encoding boundary and varies the auth
layer. `app.test.ts` is T2 with a real auth layer, not its own tier.

> **⚠️ SUPERSEDED by the [b1 addendum](#addendum-b1--database-tag-supersedes-concrete-handles) below.**
> The "keep concrete handles / not layer-swappable" reasoning here is retained as
> ADR history but no longer reflects the decision: a `Database` tag holding the
> raw `D1Database` is the single seam, and both `Drizzle` and the better-auth
> adapter derive from it, so the trio *is* layer-swappable and the one-`sqlite`
> guarantee is type-enforced rather than test-owned. See the addendum.

**One shared `d1`, surfaced two ways.** The seam is a single `d1`: the `Drizzle`
Tag for feature services, and the raw `d1` handle for the better-auth adapter.
`makeFateLayer(db, auth)` keeps taking concrete handles — it is **not** cleanly
layer-swappable, because better-auth is constructed off the raw `d1`, and a
`Layer<Drizzle>` swap would hand features and auth two different in-memory
SQLites. Tests must thread **one** `sqlite` into both surfaces.

**Fidelity boundary.** `node:sqlite` is the same engine as D1 — keyset order
(BINARY collation), `ON CONFLICT`, `COUNT(*)`, soft-delete filters are
hermetically faithful, so **domain correctness belongs in T1/T2**. Genuine
real-D1-only divergences, reserved for T3 (or a binding-level micro-tier):

1. batch meta-envelope (the fake hardcodes `meta: {}`),
2. `foreign_keys` default (fake defaults ON, D1 defaults OFF),
3. D1 `changes` / `last_row_id` / statement-index-on-batch-error,
4. the DO + SSE + D1 composite (`fate-live.test.ts`).

Recorded gap: **batch-meta fidelity (#1, #3) is currently untested at every
tier** — T3 asserts over the fate wire protocol, which never serializes
`changes`/`last_row_id`. Resolve by adding a narrow binding-level micro-tier
holding `env.PHOENIX_DB`, or document it as explicitly untested. Do not pretend
T3 covers it.

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

## Consequences

- The `unit` Vitest project must be re-tiered. Do it atomically across
  `vitest.config.ts` + `package.json` scripts + CI, **or** introduce T0 as a
  `*.unit.test.ts` naming convention inside the existing project — the latter
  avoids a third Vitest project, which would re-trigger Vitest 4's distinct-
  `sequence.groupOrder` rule (the two projects today are `groupOrder` 0/1 with
  differing `maxWorkers`). Convention-first is preferred.
- Domain-correctness assertions move from T3 down to T1/T2. This is a **fixture
  rewrite, not a relocation**: seed by direct INSERT, not by N HTTP voter
  sign-ups (the current flake engine in `sozluk-read`).
- `makeFateLayer` stays signature-stable (concrete `db` + `auth`); tests own the
  one-`sqlite` guarantee. `createDrizzle` stays exported for the auth adapter.
- Banned: calling a test that boots `node:sqlite` a "unit" test; filing
  deterministic-SQL correctness assertions in T3.
- Follow-on (deliberately **not** in this ADR — these are API shapes, destined
  for `.patterns/`, not decisions): extract `makeSqliteTestDb()` with
  `PRAGMA foreign_keys=OFF` baked in, extract `runFateOp()` (owning
  `makeLiveBusTest` internally to preserve the single-`provide`
  `multipleEffectProvide` contract), then pattern-doc the test-kit API.

## Addendum (b1) — `Database` tag supersedes concrete handles

**Status: accepted (this ADR stays `accepted`; this addendum revises one section).**

This addendum supersedes the **"One shared `d1`, surfaced two ways"** section in
the Decision above (and the matching `makeFateLayer` bullet under Consequences).
That section claimed `makeFateLayer(db, auth)` *must* take concrete handles and
is **not** cleanly layer-swappable, because better-auth is built off the raw
`d1`. That premise is wrong — it conflated "one shared handle" with "passed as a
concrete argument."

**Decision (b1):** introduce a `Database` tag holding the raw `D1Database`. It is
the single seam. Both downstream surfaces *derive* from it:

- the `Drizzle` service is built from `Database`, and
- the better-auth adapter is built from `Database`.

Because both derive from the **same** `Database` tag, they are guaranteed to
share one underlying handle — the one-`sqlite` invariant the original section
asked tests to uphold by hand is now **type-enforced** by the layer graph, not
test-owned. The trio is therefore genuinely layer-swappable: a test (or any
consumer) provides one `Database` layer and both `Drizzle` and auth follow. No
caller threads two handles; no caller can accidentally hand features and auth two
different in-memory SQLites.

**What this changes vs. the superseded text:**

- "*`makeFateLayer` keeps taking concrete handles*" → the raw handle lives behind
  the `Database` tag; surfaces derive from the tag, not from passed-in concretes.
- "*not cleanly layer-swappable*" → it **is** layer-swappable; swap the `Database`
  layer and `Drizzle` + auth both rebind.
- "*Tests must thread **one** `sqlite` into both surfaces*" → tests provide one
  `Database` layer; the single-handle guarantee is enforced by construction.

Everything else in this ADR (the four-tier taxonomy, the fidelity boundary, the
graduation gates) stands unchanged.

Builds on [0011](0011-drizzle-context-service.md),
[0014](0014-drizzle-run-batch-as-service-methods.md),
[0029](0029-worker-runtime-servicemap.md),
[0032](0032-alchemy-beta45-and-dev-model.md), and
[0038](0038-dependency-patches-local-only.md).
