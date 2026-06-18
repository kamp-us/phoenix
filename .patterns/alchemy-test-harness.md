# Integration test harness — alchemy `Test.make`, per-file isolated stages

Phoenix's integration tests deploy the **real alchemy stack to real remote
Cloudflare** — one **isolated stage per test file** — and assert **black-box
over HTTP** against the deployed worker URL. No miniflare, no
`@cloudflare/vitest-pool-workers`, no `SELF.fetch`, no `env.PHOENIX_DB`, no
`runInDurableObject`, and no single shared deploy. This is the path every
integration test takes.

This is the ADR [0082](../.decisions/0082-two-test-tiers-unit-integration.md)
substrate. It supersedes both the miniflare-based recipe in
[effect-testing.md](./effect-testing.md) (the legacy reference, retired) **and**
the prior single-shared-deploy-on-local-workerd harness (a hand-rolled
`globalSetup` that deployed once to a local workerd and published a
`PHOENIX_TEST_URL` — it raced itself and is the root cause of #547 / #220 /
#560). The new path is the only path for product code that touches D1, the DOs,
or the fate seam.

## The shape

Each test file calls `integrationStack(import.meta.url)` once at module top
level. That factory (`tests/integration/_integration.ts`) stands up a per-file
`Test.make`, deploys the phoenix `Stack` under its own isolated stage, retries
the first request, and returns the black-box `harness`:

```ts
import {describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url); // per-file deploy + HTTP harness

describe("fate seam — /fate", () => {
  it("health resolves data produced by an Effect service method", async () => {
    const result = await h.fate({kind: "query", name: "health", select: ["status"]});
    expect(result.ok).toBe(true);
  });
});
```

Vitest's stock `it` + `expect` (not `it.effect`) is the right shape: test
bodies are HTTP-only plain async functions. The `Effect`-aware path inside the
worker is exercised through its observable HTTP behavior, not by yielding to
Effects in the test body — the only Effect lives in the `beforeAll(deploy)`
lifecycle, hidden inside `integrationStack`.

## How `integrationStack` works (`tests/integration/_integration.ts`)

It mirrors the canonical alchemy `Test.make` idiom (the alchemy-effect fork's
`AGENTS.md` test section + `examples/cloudflare-worker-async/test/integ.test.ts`):

```ts
const {beforeAll, afterAll, deploy, destroy} = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),          // real remote state — NOT localState()
});

const stack = beforeAll(deploy<StackOutput>(Stack, {stage}).pipe(/* capture url + retry */));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy<StackOutput>(Stack, {stage}));
```

- **Per-file isolated stage.** `stage` is derived from the test file's basename
  (`it-<slug>`), so each file deploys its own worker + D1 under a distinct
  Cloudflare stage. Files no longer share one deploy, so they run **in
  parallel** (`fileParallelism: true` in `vitest.config.ts`) — the parallelism
  that replaces the prior forced single fork.
- **Real remote D1, one migration path.** `Cloudflare.state()` + `dev: false`
  (the default, since `ALCHEMY_DEV` is unset under the integration run) deploys
  the real worker. D1 is migrated by the **existing**
  `D1Database({migrationsDir, migrationsTable: "drizzle_migrations"})` resource
  in `worker/db/resources.ts` that `deploy` applies — there is no second
  migration path to keep in sync. (alchemy never emulates D1 — even `alchemy
  dev` binds real remote D1; ADR 0032/0082.)
- **Retry-first-request.** A freshly-deployed `workers.dev` URL 404s for a few
  seconds while the route propagates, so the `beforeAll` hook probes
  `GET /api/health` with `Effect.retry` on `Schedule.spaced("2 seconds")` capped
  at `times: 30` — a pure *spaced* schedule (fixed 2s gap, no exponential phase),
  never a `Date.now()` polling loop. The `times` cap fails fast inside the hook
  timeout if a worker never goes ready, instead of hanging. The resolved URL is
  stashed in a holder the synchronous `harness(getUrl)` reads.
- **Per-request placeholder-404 backstop (the general cold-edge handling).** The
  health probe above only warms **one** route at **one** PoP; the per-file model
  stands up ~11 brand-new `*.workers.dev` hostnames per run, so any test's
  *first* request can still draw a cold edge that hasn't propagated and get
  Cloudflare's HTML placeholder 404. So the harness `req` loop itself
  (`_harness.ts`) re-issues on that placeholder, on **every** path
  (`fate`/`fateBatch`/`signUp`/`json`), not just `/api/health`. `req` peeks a
  404's body (clone-and-read, only on a 404, so the hot path is untouched) and,
  when `isCloudflarePlaceholder404` matches — a 404 whose body contains
  `There is nothing here yet` **or** starts with `<!DOCTYPE html>` — treats it
  like a connection error and retries on the same bounded loop (`sleep(250)`,
  capped at 20 tries); a fresh edge settles within a few seconds. A real
  application 404 is structured JSON (`{ok:false,error:{code}}`), never this
  HTML, so it never matches and is returned unretried.
- **`NO_DESTROY`.** Set it locally to keep a file's deploy alive between runs
  while iterating (`afterAll.skipIf(NO_DESTROY)(destroy(...))`).

## The state-mode selector (`worker/env.ts`)

`resolveStateMode` (called by `alchemy.run.ts` at module-eval) selects
`Cloudflare.state()` vs `Alchemy.localState()` from the **dev-vs-deploy** signal
alone — **not** `CI`, and (since ADR 0082) **not** `VITEST`. Only `alchemy dev`
(its `ALCHEMY_EXEC_OPTIONS.dev` flag, or the coarser `ALCHEMY_DEV` override)
resolves to offline `localState()`. A Vitest integration run resolves to the
shared Cloudflare store exactly like a real deploy, because it now deploys to
real remote Cloudflare. The Stack's baked state and `Test.make`'s `state` option
therefore agree on `Cloudflare.state()`.

## The harness contract (`tests/integration/_harness.ts`)

`harness(getUrl)` is the black-box HTTP client. The test-author API is unchanged
from the prior harness — only its URL source changed (a per-file accessor
instead of `PHOENIX_TEST_URL`):

| Method | What it does |
|---|---|
| `h.url()` | The deployed worker URL for this file's stage. |
| `h.req(path, init?, opts?)` | `fetch(url + path, init)`; retries transient connection failures **and Cloudflare placeholder-404s** (`isCloudflarePlaceholder404`) on the bounded loop; `opts.timeoutMs` bounds one attempt. |
| `h.json(path, body, cookie?)` | POST JSON (sets `content-type`, dev `origin`, optional `cookie`). |
| `h.fate(op, opts?)` | POST one fate operation; return its single result (reads auto-retry; mutations only with `retry: true`). |
| `h.fateBatch(ops, opts?)` | POST several fate operations; return all results in order. |
| `h.signUp(email, password, name)` | Sign up via `/api/auth/sign-up/email`; return `{userId, cookie}` (falls back to sign-in on `USER_ALREADY_EXISTS`). |
| `h.seedTerm(...)` | Seed a sözlük term + definitions through the PUBLIC `definition.add` fate mutation (+ votes for scores). |
| `h.openSse(connectionId, cookie)` | Open the live SSE stream. |
| `h.liveControl(connectionId, ops, cookie)` | POST control messages (subscribe / unsubscribe). |

`readFrame`/`readEvent`/`frameData` (also exported from `_harness.ts`) parse the
SSE wire on the test side.

## What lives where

- **The per-file lifecycle** — `tests/integration/_integration.ts`. `Test.make`
  + `beforeAll(deploy(Stack, {stage}))` + `afterAll.skipIf(NO_DESTROY)(destroy)`
  + retry-first-request. Self-supplies `BETTER_AUTH_SECRET` / `ENVIRONMENT` when
  absent so the suite is self-contained on a clean runner.
- **The HTTP harness** — `tests/integration/_harness.ts`. The client surface
  above. Pure HTTP; deploys nothing.
- **The DNS shim** — `tests/integration/_localhost-dns.ts`. A small `node:dns`
  patch so `*.localhost` resolves; retained for the dev/local path (orthogonal
  to the harness swap).
- **The test files** — `tests/integration/*.test.ts`. Black-box only: call
  `h.fate(...)`, `h.json(...)`, etc.; assert on the response.

## Per-file isolation removes the shared-deploy race

The prior harness deployed **once** and shared one worker + D1 across every test
file, forced into a single fork to dodge a flake. That shared deploy raced
itself: overlapping writes against one D1, one long-lived workerd↔D1 connection
whose latency crept up over the run, and a single lifecycle teardown that could
interrupt held-open SSE streams. ADR 0082 traces #547 (all-fibers-interrupted
timeout), #560 (deterministic-looking redness), and #220 (shared-deploy timing
assertion) to that **one** root cause. Per-file isolated stages give each file
its own worker + D1, so there is no cross-file contention to race — the class is
gone, and the files parallelize instead of serializing.

## `test.provider` for provider-lifecycle tests

`alchemy/Test/Vitest`'s `test.provider(name, fn)` runs a test against a scratch
in-memory stack — useful for testing a provider implementation in isolation.
Phoenix doesn't author providers today, so this isn't used; if a future
phoenix-owned provider lands, `test.provider` is the right shape for its tests.

## Bun vs Vitest

`alchemy/Test/Bun` ships the same `make(...)` API over `bun:test`. Phoenix uses
Vitest (`apps/web/vitest.config.ts`) because the project already has Vitest
projects (integration + unit) and the unit project drives `@effect/vitest`'s
`it.effect`. No reason to mix runners.

## The unit-test project

The same `vitest.config.ts` defines a `unit` project for tests that **don't**
need a deployed worker — pure logic and in-process service contracts, all
offline in the node pool. Pure-logic files carry the `*.unit.test.ts` infix.
Per ADR 0082, the unit tier boots no SQL engine at all (the `node:sqlite`
stand-in is banned); a test that needs real database behavior belongs in
`integration`.

## Gotchas

- **A fully-green run can still exit non-zero.** Workerd logs an uncaught
  `All fibers interrupted without error` when a held-open `/fate/live` SSE
  stream is torn down between tests; this can surface a non-zero exit even when
  all tests pass. `vitest.config.ts`'s `onUnhandledError` drops exactly that one
  message. Tracked in [#20](https://github.com/kamp-us/phoenix/issues/20) — a
  green summary with a `✗` exit is that, not a real failure.
- **D1 create/destroy rate limits.** Per-file stages provision real D1 per run.
  If Cloudflare's D1 create/destroy rate limits bite at scale, the mitigation
  (deferred, not built — ADR 0082 Consequences) is a bounded per-fork stage pool
  (D1 created once and kept, idempotent re-migrate, data reset per file). Start
  with max parallelism; revisit only if it becomes a problem.

## Citations

- `apps/web/tests/integration/_integration.ts` — the per-file `Test.make`
  lifecycle, the isolated-stage derivation, retry-first-request.
- `apps/web/tests/integration/_harness.ts` — the HTTP harness API.
- `apps/web/worker/env.ts` — `resolveStateMode`, the dev-vs-deploy state-store
  selector (VITEST is no longer offline; ADR 0082).
- `apps/web/tests/integration/seam.test.ts` — a minimal black-box test.
- `apps/web/tests/integration/fate-live.test.ts` — SSE black-box.
- `apps/web/vitest.config.ts` — projects, pool, file parallelism.

## See also

- [ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md) — the two
  test tiers + the `Test.make` integration substrate this doc describes.
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — what the stack the
  harness deploys actually declares.
- [ADR 0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) — the dev model
  (real remote D1 even in dev; retired `LocalhostDns`).
- [effect-testing.md](./effect-testing.md) — the legacy miniflare recipe (kept
  for unit-test guidance; the integration path there is retired).
