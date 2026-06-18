---
id: 0082
title: Two Test Tiers — Unit (No DB) and Integration (Real D1 via alchemy `Test.make`)
status: accepted
date: 2026-06-17
tags: [testing, architecture, alchemy, d1]
---

# 0082 — Two Test Tiers: Unit (No DB) and Integration (Real D1 via alchemy `Test.make`)

## Context

Supersedes [0040](0040-testing-taxonomy-and-seam-graduation.md).

0040 defined a four-tier taxonomy (T0/T1/T2/T3) whose load-bearing premise was:
*"`node:sqlite` is the same engine as D1 — hermetically faithful — so domain
correctness belongs in T1/T2."* On that premise it blessed an in-process
`node:sqlite` D1 stand-in (`makeSqliteTestDb`) as the backing for service- and
app-integration tests across the worker.

The premise is wrong where it matters, and the investigation behind epic
[#563](https://github.com/kamp-us/phoenix/issues/563) established why:

- **It is not faithful.** `node:sqlite`'s FTS5 build, tokenizer, and collation
  are not Cloudflare D1's. A search test that "proves" Turkish diacritic folding
  against `node:sqlite` proves nothing about D1 — different engine.
- **It puts domain correctness on a database.** A unit test that boots any SQL
  engine — real or faked — has stopped being a unit test. Logic that can be
  wrong *even if the database behaves perfectly* (normalization, clamping,
  envelope shaping, pagination math, auth gates, empty/cursor-miss branches,
  topic-key routing) does not need a database to be tested, and reaching for one
  is a layering violation.
- **It gave false confidence.** The folding that `search.test.ts` spun up a
  faked engine + the full write→sync→resolver stack to verify is a *pure*
  function (`features/search/normalize.ts`), applied app-side *precisely because*
  the engine's `unicode61` fold is wrong for Turkish. The DB was never doing the
  thing the test claimed to check.

A second, separate finding from the same investigation: the local-dev "D1
divergence" that motivated #563 was a **ghost**. `alchemy dev` binds the **real
remote** D1 by design ([0032](0032-alchemy-beta45-and-dev-model.md); confirmed in
the alchemy source: the local worker provider binds `D1.remote(...)`, persists
only Durable Object state under `.alchemy/local/`, and there is no local D1
emulation anywhere in alchemy). The orphaned `apps/web/.wrangler/` sqlite is a
dead wrangler-era file the running worker never opens (verified by `lsof` on the
live dev `workerd`). The real problem was never two diverging databases — it was
mis-layered tests on a faked engine.

## Decision

**Two test tiers. No middle. No faked engine.**

- **`unit`** — pure logic: no database, no SQL engine, no I/O. The unit under
  test sits on a seam whose lower layer is substituted directly (the `Database` /
  `Drizzle` seam is already mockable — a `Layer.succeed(Drizzle, …)` with a
  recording or throwing `run`). Marked by the `*.unit.test.ts` infix. If a test
  boots a SQL engine, it is not a unit test.
- **`integration`** — real behavior against **real remote Cloudflare D1**, via
  the alchemy `Test.make` idiom: `beforeAll(deploy(Stack))` +
  `afterAll.skipIf(...)(destroy(Stack))` + retry-first-request, asserting over the
  live worker. D1 is migrated by the existing
  `D1Database({ migrationsDir, migrationsTable: "drizzle_migrations" })` resource
  — the same resource `deploy` uses, so there is one migration path and nothing
  to keep in sync.

**`node:sqlite` is banned outright** as a test backing. `makeSqliteTestDb` /
`apps/web/worker/db/sqlite-d1.testing.ts` and its self-test are deleted. The
T0/T1/T2/T3 numbering is dropped — `unit` and `integration` are the only names.

**Principle — no domain decision welded to SQL execution.** Cursor resolution is
a *port* (a thin DB read); the keyset / cursor-miss *decision* and the page
envelope are *pure* and unit-testable. Domain logic that today executes inline
inside `run((db) => …)` is to be lifted above that seam so it can be tested with
no database. The litmus for tier placement: *"Could this be wrong even if the
database behaved perfectly?"* — yes → `unit`; only-wrong-if-the-DB-differs →
`integration`.

**Integration runs all-on-every-push, parallelized via per-file isolated
stages** — the simplest shape, maximizing parallelism to minimize wall-clock.
This is the alchemy-native model (`Test.make` per file, each its own stage), not
a bespoke harness.

**`ALCHEMY_DEV=1`** runs the worker in local `workerd` for a fast inner loop, but
D1 binds remote in that mode too — so it speeds local iteration only and is **not**
a CI cost lever. The CI cost lever is the unit/integration split itself (fewer
DB-touching assertions), not dev mode.

**Change-scoped selection is a `unit`-tier and local-loop accelerator, not an
`integration`-gate one.** `vitest --changed` / `related` narrows by the resolved
import graph: sound for `unit` (tests import disjoint modules → a change selects
only the touched tests) and ideal for the local dev loop. It does **not** narrow
`integration` — every integration test deploys the whole worker (one worker = one
`Stack`), so any worker change is in all of their graphs and selects all of them;
and a black-box harness with no import edge to worker source under-selects
outright. So the `integration` gate runs **full, parallelized via isolated
stages** — its speed comes from parallelism, not selection. `forceRerunTriggers`
(migrations, `alchemy.run.ts`, the harness) backstops the `unit` tier against the
out-of-band edges the import graph cannot see.

## Consequences

- **Banned:** calling any test that boots a SQL engine a "unit" test; using
  `node:sqlite` (or any faked engine) as a test backing; asserting pure logic
  through a database; filing a domain decision welded to SQL execution.
- **Deleted:** `apps/web/worker/db/sqlite-d1.testing.ts` + `sqlite-d1.testing.test.ts`.
- **Migration cost (epic execution, tracked under #563, not this ADR):** each
  `makeSqliteTestDb` suite splits — pure-logic assertions move to `unit` (several
  are already duplicated by `keyset.unit.test.ts` / `normalize.unit.test.ts`, so
  they become deletions), genuine DB-fidelity assertions move to `integration` on
  real D1; the hand-rolled `tests/integration/_global-setup.ts` / `_harness.ts`
  are replaced by `Test.make`. The 3-site cursor-port extraction
  (`features/sozluk/Sozluk.ts`, `features/pano/Pano.ts`, `features/search/Search.ts`)
  is epic work, deliberately out of scope here.
- **Cost:** ≈ $0 in money (D1 test volume sits in the free tier). Wall-clock for
  the integration job rises modestly as ~30–40 fate-op assertions move onto
  network-backed real D1, offset by per-file-stage parallelism (the existing
  suite is forced single-fork to dodge the prior flake; isolated stages remove
  that constraint). the shared-deploy race cluster — the
  "all fibers interrupted" timeout ([#547](https://github.com/kamp-us/phoenix/issues/547)),
  the deterministic-looking redness ([#560](https://github.com/kamp-us/phoenix/issues/560)),
  and the shared-deploy timing assertion ([#220](https://github.com/kamp-us/phoenix/issues/220))
  are one root cause: a single-fork shared deploy racing itself. It is a lifecycle
  bug in the hand-rolled harness, not an inherent cost of real D1 — the per-file
  isolated-stage `Test.make` lifecycle removes the class, and the cluster closes
  when the swap lands.
- **Deferred lever (not built):** per-file isolated stages provision real D1 per
  run; if Cloudflare D1 create/destroy rate limits bite, the mitigation is a
  bounded per-fork stage pool (D1 created once and kept, idempotent re-migrate,
  data reset per file). We start with max parallelism and revisit only if it
  becomes a problem.
- **Irreducible `integration` core (stays on real D1):** batch atomicity
  rollback; idempotency via `meta.changes` on composite-PK conflict; keyset
  *execution* verticals (collation / NULL / date / string tiebreaks); FTS5 bm25 /
  prefix / MATCH and the write→sync→read dual-write loop ([0080](0080-site-search-lexical-bar-semantic-discovery.md));
  read-row shaping and aggregate counters; the better-auth session round-trip.
- The `vitest.config.ts` projects, `package.json` scripts, and CI job re-tier from
  the 0040 four-tier model to the two-tier model atomically (epic execution).

Builds on [0029](0029-worker-runtime-servicemap.md),
[0011](0011-drizzle-context-service.md), [0032](0032-alchemy-beta45-and-dev-model.md),
[0080](0080-site-search-lexical-bar-semantic-discovery.md), and the alchemy `Test.make` testing model.
Supersedes [0040](0040-testing-taxonomy-and-seam-graduation.md).
