# Integration test harness — alchemy `Test.make`, shared + dedicated remote stages

> Derived from `alchemy@2.0.0-beta.59` — re-verify on pin bump.

Phoenix's integration tests deploy the **real alchemy stack to real remote
Cloudflare** and assert **black-box over HTTP** against the deployed worker URL.
No miniflare, no `@cloudflare/vitest-pool-workers`, no `SELF.fetch`, no
`env.PHOENIX_DB`, no `runInDurableObject`. Two stage modes exist (ADR
[0104](../.decisions/0104-two-mode-integration-test-tier.md)):

- **The run-scoped SHARED stage — the default.** One stage deployed **once per
  run** in a vitest `globalSetup`; most files (~29 today) are pure HTTP clients
  over its injected handle via `sharedStack()`.
- **Per-file DEDICATED stages — the exception.** A file whose assertions can't
  tolerate other files' concurrent writes deploys its own isolated stage via
  `integrationStack(import.meta.url)` (6 files today: the keyset paged-walk
  files `search` / `sozluk-keyset` — their lead-sort statistic is a
  cross-file-global corpus stat, #1143 — plus `fate-live-posts`,
  `fts-backfill` (drops real infrastructure), `search-error-vs-empty`,
  `pano-hot-score-decay`).

This is the ADR [0082](../.decisions/0082-two-test-tiers-unit-integration.md)
substrate. It supersedes both the miniflare-based recipe in
[effect-testing.md](./effect-testing.md) (the legacy reference, retired) **and**
the prior single-shared-deploy-on-local-workerd harness (the root cause of
#547 / #220 / #560). It is the only path for product code that touches D1, the
DOs, or the fate seam.

## The shape

```ts
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();              // pure client over the run-scoped shared stage
const NS = nsToken(import.meta.url);  // prefix EVERY seeded slug/email/id with this

describe("fate seam — /fate", () => {
  it("health resolves data produced by an Effect service method", async () => {
    const result = await h.fate({kind: "query", name: "health", select: ["status"]});
    expect(result.ok).toBe(true);
  });
});
```

A shared-stage file **namespaces every row it seeds** with `nsToken` (a
deterministic, file-derived prefix) and scopes every assertion to those rows —
the shared D1 is one database across ~29 files. A dedicated file swaps the
factory: `const h = integrationStack(import.meta.url);` (no namespacing needed —
the stage is its own).

Vitest's stock `it` + `expect` (not `it.effect`) is the right shape: test bodies
are HTTP-only plain async functions. The `Effect`-aware path inside the worker
is exercised through its observable HTTP behavior; the only Effects live in the
deploy lifecycle, hidden inside `_integration.ts` / `_global-setup.ts`.

## How `integrationStack` works (`tests/integration/_integration.ts`)

The per-file lifecycle is alchemy's `Test.make` idiom (`alchemy@2.0.0-beta.59` —
`src/Test/Vitest.ts` over `src/Test/Core.ts`):

```ts
const {beforeAll, afterAll, deploy, destroy} = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),          // real remote state — Test.make DEFAULTS to localState()
});

const stack = beforeAll(deploy<StackOutput>(Stack, {stage}).pipe(/* hardening below */));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy<StackOutput>(Stack, {stage}));
```

- **Always pass an explicit, run-unique stage.** `Test.make` **defaults the
  stage to the literal `"test"`** and the state store to `localState()`
  (`alchemy@2.0.0-beta.59` — `src/Test/Core.ts`, `MakeOptions`). An ad-hoc
  `deploy(Stack)` that omits `{stage}` therefore creates real account resources
  named `phoenix-…-test-<suffix>` that no sweep reclaims (#2340) — never call
  `deploy` without the harness's stage. The harness stage is
  `it-<readable>-<disc>` where `<disc>` hashes `<slug>|<runToken>` (CI's
  `<run-id>-<run-attempt>`, else a per-process token) — run-unique so two
  overlapping CI runs never collide on `DatabaseAlreadyExists` (#689); under
  `NO_DESTROY` it's the stable `it-<slug>` so a kept-alive local deploy
  re-adopts by name (`_stage-name.ts`, unit-pinned).
- **Real remote D1, one migration path.** `dev: false` is the effective default
  (`Test.make` reads `ALCHEMY_DEV`, unset here — `src/Test/Core.ts`,
  `resolveDev`), so the deploy is real. D1 is migrated by the **existing**
  `Cloudflare.D1.Database({migrationsDir, migrationsTable: "drizzle_migrations"})`
  resource in `worker/db/resources.ts` that `deploy` applies — no second
  migration path. (alchemy never emulates D1 — even `alchemy dev` binds real
  remote D1; see [alchemy-drizzle-d1.md](./alchemy-drizzle-d1.md), ADR 0032/0082.)
- **Deploy hardening + readiness.** `deployTransientRetry` retries a transient
  CF deploy error (bounded exponential — alchemy deploys are convergent, so
  re-running `deploy(Stack, {stage})` reconciles the same stage, #1019). Then
  three warm probes ride the ONE readiness primitive `awaitEdgeReady` (ADR
  [0127](../.decisions/0127-unified-edge-readiness-primitive.md),
  `_edge-ready.ts`): `awaitWorkerReady` polls `/api/health` until
  `{status:"ok"}`, `warmLiveDO` front-loads the lazy DO's cold-start 503 on
  `/fate/live`, and `warmFateRead` (dedicated stages only) warms `POST /fate` +
  the D1 read replica. Warmups are readiness optimizations, not assertions —
  they log-and-continue on exhaustion.
- **D1 coordinates off the compiled output.** The stack returns
  `{url, domains, databaseId, accountId}`; the harness reads the deployed D1's
  uuid straight off that output for its setup-only REST path (#692) — never a
  reconstructed physical name.
- **`NO_DESTROY`.** Set it locally to keep a file's deploy alive between runs
  while iterating (`afterAll.skipIf(NO_DESTROY)(destroy(...))`).

## The run-scoped shared stage (`sharedStack()` + globalSetup)

`tests/integration/_global-setup.ts` deploys `Stack` under
`sharedStageName(runToken)` (`it-shared-<disc>`, run-unique like the per-file
name) through `alchemy/Test/Core`'s `run` (the same runtime `Test.make` wraps
`deploy` with), then `project.provide(...)`s the worker URL + D1 coordinates;
`sharedStack()` builds the SAME `harness(urlAccessor, d1Accessor)` over those
`inject(...)` values, with no `beforeAll`/`afterAll` of its own. All deploy
hardening (`deployTransientRetry`, `awaitWorkerReady`, `warmLiveDO`,
`ensureIntegrationEnv`, `runTokenFromEnv`) lives ONCE in `_integration.ts` and
is reused by both paths. The globalSetup self-gates on `vitest.projects`
containing the `integration` project, so `test:unit` (`--project unit`) deploys
nothing.

This collapsed the per-run deploy surface from ~24 ephemeral `it-*` stages to
~7 (one shared + the dedicated files) — the structural shrink of the
create/destroy surface every CF flake class scales with (#1010 / #1019 /
#1020), which also retired the fork cap: the integration project runs uncapped
`fileParallelism: true`.

## CF API rate-limit discipline — two complementary halves

Every integration-test Cloudflare REST call — the setup path (`cloudflareApi` →
`runD1Query` in `_harness.ts`; `setLastActivityAt` / `execD1` / `promoteToYazar`)
AND a test's data-plane `makeD1Rest` queries — hits ONE account's D1
control-plane, which trips the account-global rate limit (HTTP 429, code 971
"TooManyRequests") under concurrent-stage batch load. **All of them go through one
transport, `_cf-rest-transport.ts`**, which composes two halves:

- **Reactive per-call retry** — `cfFetchWithRateLimitRetry` (`_d1-rest-retry.ts`):
  after a 429 fires, replay the one call with full-jitter exponential backoff
  (429 is a pre-execution reject, so replay is safe; #2915), floored by a
  CF-supplied `Retry-After`. The budget is a **deadline** (`D1_REST_BUDGET_MS`),
  not an attempt count: with full jitter, "5 retries" is a budget with a
  near-zero lower bound, which is why the shipped retry burned out against a
  ~290s 429 plateau and red five bystander suites anyway (#3548). It never masks
  a real failure — only a 429 is retried, and exhaustion surfaces the final 429
  (raised by `cloudflareApi` as `CfRateLimitError`, naming the call, why it
  stopped, and how its elapsed time split).
- **Proactive shared throttle** — `cfApiThrottle` (`_cf-api-throttle.ts`, #3081):
  a concurrency cap + jittered start-pacing, so fewer 429s fire in the first
  place. Both knobs are env-tunable (`CF_API_MAX_CONCURRENT` /
  `CF_API_MIN_SPACING_MS`).

**Composition order: retry AROUND throttle** (`retry(() => throttle.run(send))`),
inverting #3081's original note. A call sleeping in backoff is not in flight, so
it must not hold an in-flight slot — under the old order four backing-off calls
held all four slots and head-of-line-blocked every other CF call in the fork.
This order also start-paces the retries themselves.

**The two halves must not bill each other (#3548, the PR #4033 merge-queue
ejection).** Holding a slot per attempt means a logical call re-enters the
harness's own queue on every retry — and a wall-clock deadline then charges that
self-imposed queueing to the budget it meant to spend asking Cloudflare. The
ejecting run gave up after "2 attempts over 45136ms", most of it queued rather
than rate-limited — CF sent no usable `Retry-After` on this path (`retryAfter:
Millis 0`, run `29665891972`), and on that premise one backoff at attempt 0 is
capped at 500ms. The premise is load-bearing: a `Retry-After` is a *floor* and is
not bounded by that ceiling, so a large one also produces "2 attempts over ~45s"
and the elapsed numbers alone cannot separate the two. Both sinks are fixed and
the attrition breakdown now records `retryAfterMs`, so the next occurrence is
read off the log line rather than inferred. Either way the operative conclusion
holds: **the budget was never spent, so raising it would have fixed nothing.**
Three rules follow, and each is pinned by a unit test:

- **A sleeping call is not in flight — including one asleep in start-pacing.**
  `pace()` runs *before* the slot is acquired, not inside it. Pacing is a rate
  limit, the semaphore is a concurrency limit; nesting them makes the rate limit
  eat the concurrency limit.
- **Throttle queueing is not retry attrition.** `throttle.run` reports what it
  made a call wait (`onQueued`); the retry deducts it, so `budgetMs` means "up to
  this much time with CF actually answering 429". Giving up reports the split
  (`queuedMs` / `backoffMs` / budget spent) and a `reason`, so a repeat reads off
  the log line instead of being re-derived from the job log.
- **Deducting queueing costs a bound, so keep the other one.** Once queueing is
  uncharged, `budgetMs` no longer limits the call in wall clock — only
  `maxRetries` times however long the throttle queues does, which at 24 attempts
  can outlive vitest's 120s `testTimeout` and hand back the opaque "Hook timed
  out" the named 429 exists to replace. So a hard wall-clock ceiling
  (`D1_REST_WALL_CLOCK_CEILING_MS`) is held alongside the CF-facing budget, and
  the `reason` names which bound fired (`wall-clock-ceiling` vs
  `budget-exhausted`) — a give-up is never ambiguous about what ended it. The
  guarantee is per logical call: a test making several protected CF calls during
  a sustained plateau can still exceed `testTimeout`.

A `Retry-After` longer than the remaining budget ends the loop **immediately**
(`retry-after-exceeds-budget`) rather than sleeping out the remainder to buy one
attempt at the moment it expires — a fast, correctly-named red beats a slow one.

**Build the client through the transport, never by hand.** Use
`makeIntegrationD1Rest` / `integrationRestLayer`; a per-file
`Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)` or `makeD1RestFromEnv`
is the BARE fetch with no retry and no throttle. That opt-in-ness is what red
`pasaport-ban.test.ts` in run `29665891972` while its wrapped sibling survived
the same 429 storm, so `_cf-rest-transport.unit.test.ts` now fails closed on any
non-exempt file in the integration directory that re-introduces one.

**Ceiling (why this isn't the whole 429 story):** the throttle is an in-process
singleton — under `isolate:false` it is shared across files in the same fork, but
it does NOT reach across forks or across separate CI runs. The observed
"~24 concurrent" 429 pressure is a CROSS-run aggregate (~4 overlapping
`merge_group` runs on the one account), and the dominant 429 fires inside
alchemy's OWN deploy path, which the harness can't wrap. Those need the
out-of-harness levers named in #3081 (a CI `concurrency:` group; 429 backoff in
alchemy's deploy path via `pnpm patch`, ADR 0038). This throttle is the
run-agnostic backoff on the slice the harness owns.

Read the transport's coverage honestly when diagnosing a 429 run: **stage
create/destroy is the bulk of the CF traffic and none of it goes through this
transport.** In the PR #4033 ejection the teardown 429s were
`DELETE /accounts/{id}/flagship/apps/{appId}/flags/{flagKey}` raised inside
`alchemy`/`@distilled.cloud`, warned as leaked stages — unthrottled, competing
for the same account bucket the tests then can't get through. The harness
throttle governs a minority of the calls; a 429 storm is not evidence that its
knobs are mis-set.

## Teardown is best-effort — leaked stages are a known class

Both destroy paths (`afterAll` per-file, the globalSetup teardown) are
**cleanup, not assertions**: a CF delete-ordering Conflict ("referenced by
Worker script", the #813 missing downstream edge) or a `WorkerNotFound` is
caught, logged loud, and swallowed, so a green suite is never redded by its own
teardown. Consequences worth knowing (they feed the #2340 inventory-drift
class):

- A **failed destroy leaks the stage's worker + D1** (swept by the nightly
  orphan sweep, which classifies `it-*` stages — #690; durable fix #813).
- A **deploy that throws mid-way orphans its partially-created D1**: run-unique
  stage names mean the next run never overwrites it (#690).
- Anything deployed **outside the harness's `it-*` naming** — e.g. a bare
  `deploy(Stack)` landing on `Test.make`'s default `"test"` stage — falls
  outside the sweep's classifier entirely and accumulates forever (#2340).
- `NO_DESTROY` intentionally keeps a stage alive; it is a local iteration tool,
  not for CI.

## The state-mode selector (`worker/env.ts`)

`resolveStateMode` (called by `alchemy.run.ts` at module-eval) selects
`Cloudflare.state()` vs `Alchemy.localState()` from the **dev-vs-deploy** signal
alone — **not** `CI`, and (since ADR 0082) **not** `VITEST`. Only `alchemy dev`
(its `ALCHEMY_EXEC_OPTIONS.dev` flag, or the coarser `ALCHEMY_DEV` override)
resolves to `Alchemy.localState()` — the *state store*, not the loop: the
worker still binds a **real** Cloudflare D1 in your personal stage, while its DO
namespaces run on a local provider (`alchemy@2.0.0-beta.59 —
src/Cloudflare/Workers/LocalWorkerProvider.ts`, where `case "d1"` returns
`D1.remote(...)` and `case "durable_object_namespace"` returns
`DurableObjectNamespace.local(...)`; ADR
[0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) names D1/R2/KV as the
real resources). [`alchemy-stack-deploy.md`](alchemy-stack-deploy.md) states the
same split. A Vitest integration run resolves to the shared Cloudflare store
exactly like a real deploy, because it deploys to real remote Cloudflare. The Stack's baked state
and `Test.make`'s `state` option therefore agree on `Cloudflare.state()`.

## The harness contract (`tests/integration/_harness.ts`)

`harness(getUrl, getD1Target)` is the black-box HTTP client — pure HTTP plus a
setup-only Cloudflare D1 REST seam; it deploys nothing.

| Method | What it does |
|---|---|
| `h.url()` | The deployed worker URL for this file's stage. |
| `h.req(path, init?, opts?)` | `fetch(url + path, init)`; retries transient connection failures **and Cloudflare placeholder-404s** on a bounded loop (`sleep(250)`, 20 tries); `opts.timeoutMs` bounds one attempt (a stall throws — only idempotency-aware callers retry it). |
| `h.json(path, body, cookie?)` | POST JSON (sets `content-type`, dev `origin`, optional `cookie`; 30s per-request bound). |
| `h.fate(op, opts?)` | POST one fate operation; return its single result (reads auto-retry; mutations only with `retry: true`). |
| `h.fateBatch(ops, opts?)` | POST several fate operations; return all results in order. |
| `h.signUp(email, password, name)` | Sign up via `/api/auth/sign-up/email`; return `{userId, cookie}` (falls back to sign-in on `USER_ALREADY_EXISTS`). |
| `h.seedTerm(...)` | Seed a sözlük term + definitions through the PUBLIC `definition.add` fate mutation (+ votes for scores); the stored `authorName` is uniquified per run (#2116). |
| `h.touchTerm(definitionId)` | Re-stamp a term's `last_activity_at` to "now" via a fresh voter's up-vote — moves the clock forward but can't pin a specific second. |
| `h.setLastActivityAt(slug, epochSeconds)` | **Setup-only controlled write:** stamp `term_record.last_activity_at` to an EXACT whole-second epoch via the Cloudflare D1 REST API, so a keyset tie is **constructed**, never raced on wall-clock coincidence (#643). NOT the worker binding, never on an assertion path. |
| `h.execD1(sql, params?)` | One setup-only SQL statement over the same D1 REST seam — the fault-injection a black-box test can't reach (e.g. drop an FTS table to prove the read path errors instead of masking, #549). |
| `h.countD1(sql, params?)` | **The one read-assertion exception:** how many rows one SELECT returns, over the same D1 REST seam. Only for a row whose every public read path ships dark behind a default-off flag, so no session can observe its absence (the account-deletion sweep of `user_mute` / `mecmua_subscription` / `caylak_visibility_preference`, #6733). Once a flag flips, the assertion belongs back on the public read. |
| `h.promoteToYazar(userId)` | Flip `user.tier` over the D1 REST seam — needed since #1810's earn-to-vote gate; there is no public promotion mutation. Setup-only. |
| `h.d1Target()` | This stage's `{accountId, databaseId}` for external setup tools (the fts-backfill CLI, #645). |
| `h.openSse(connectionId, cookie)` | Open the live SSE stream (no timeout — the body stays open). |
| `h.liveControl(connectionId, ops, cookie)` | POST control messages (subscribe / unsubscribe); retries the cold-DO 503 (#1173). |

The D1 REST methods authenticate with the same `CLOUDFLARE_API_TOKEN` the
deploy uses; the account/database ids come off the deploy output, so that token
is the only extra env the setup seam needs. The black-box contract governs what
a test *asserts*, not how it arranges the rows it asserts against.

`readFrame`/`readEvent`/`frameData` (also exported from `_harness.ts`) parse the
SSE wire on the test side.

## What lives where

- **The per-file lifecycle + shared hardening** — `tests/integration/_integration.ts`
  (`integrationStack`, `sharedStack`, the warm probes, `ensureIntegrationEnv` —
  self-supplies `BETTER_AUTH_SECRET` / `ENVIRONMENT` when absent so the suite is
  self-contained on a clean runner).
- **The run-scoped deploy** — `tests/integration/_global-setup.ts`.
- **Stage naming (pure, unit-tested)** — `tests/integration/_stage-name.ts`
  (`stageName`, `sharedStageName`, `nsToken`).
- **The readiness primitive** — `tests/integration/_edge-ready.ts`
  (`awaitEdgeReady`, `edgeFetch`, the typed placeholder-404; ADR 0127).
- **Transient-deploy classification** — `tests/integration/_deploy-transient.ts`.
- **The HTTP harness** — `tests/integration/_harness.ts`.
- **The test files** — `tests/integration/*.test.ts`. Black-box assertions
  only, with two sanctioned exceptions: fixture setup the public seam genuinely
  cannot express (`setLastActivityAt` / `execD1` / `promoteToYazar`, above), and
  the single read exception `countD1` — a row whose every public read path ships
  dark behind a default-off flag has no session that could observe it, so the
  absence is unassertable over HTTP (#6733). Both stay narrow: a row a live
  session *can* read is asserted through that read, never through D1.

## Why isolated stages (and why most files still share one)

The pre-0082 harness deployed **once** and shared one worker + D1 across every
file, forced into a single fork — that shared deploy raced itself (#547 / #560 /
#220, one root cause). Per-file isolated stages removed the contention class and
unlocked parallelism; ADR 0104 then observed the opposite cost — ~24 real
create/destroy cycles per run against one eventually-consistent CF account is
its own flake surface — and moved every file that doesn't *need* isolation onto
the one shared stage, keeping dedicated stages only where a file's assertions
depend on cross-file-global state (corpus statistics, infrastructure
fault-injection). Isolation is now a per-file property you opt into, not the
default.

Note the distinct axis: the integration project also sets `isolate: false`
(vitest's JS-module-registry isolation), sharing one parsed module graph per
fork (~19% faster CI, #958). That does NOT merge stages — it only skips
re-importing the worker barrel per file.

## `test.provider` for provider-lifecycle tests

`alchemy/Test/Vitest`'s `test.provider(name, fn)` runs a test against a scratch
in-memory stack — useful for testing a provider implementation in isolation
(`alchemy@2.0.0-beta.59` — `src/Test/Vitest.ts`). Phoenix doesn't author
providers today; if a phoenix-owned provider lands, `test.provider` is the right
shape for its tests.

## Bun vs Vitest

`alchemy/Test/Bun` ships the same `make(...)` API over `bun:test`
(`alchemy@2.0.0-beta.59` — `src/Test/Bun.ts`). Phoenix uses Vitest
(`apps/web/vitest.config.ts`) because the project already runs Vitest projects
and the unit tier drives `@effect/vitest`'s `it.effect`. No reason to mix
runners.

## The offline projects (`unit`, `client`)

The same `vitest.config.ts` defines two more projects that **don't** deploy:

- **`unit`** — pure logic and in-process service contracts, offline in the node
  pool (`worker/**`, `src/**`, plus the harness substrate's own
  `*.unit.test.ts`). Per ADR 0082 the unit tier boots no SQL engine at all (the
  `node:sqlite` stand-in is banned); a test that needs real database behavior
  belongs in `integration`.
- **`client`** — the SPA component/DOM tier (#1419): `src/**/*.test.tsx` under
  `jsdom`, fork heap capped at 512MB so a passive-update loop crashes fast
  instead of hanging (#1470).

**Change-scoped selection is a unit-tier + local-loop accelerator only.**
`vitest --changed` / `related` narrows by the resolved import graph — sound for
`unit`, useless for `integration`: every integration test deploys the whole
worker, and the black-box harness has no import edge to worker source — so the
gate runs `integration` **full**, never `--changed`-selected (ADR 0082). The
root-level `forceRerunTriggers` backstops the out-of-band edges the import graph
can't see — the migrations dir (SQL read at runtime), `alchemy.run.ts`, and the
harness substrate (`tests/integration/_*.ts`) — forcing the full run when any of
them changes.

## Gotchas

- **A fully-green run can still exit non-zero.** Workerd logs an uncaught
  `All fibers interrupted without error` when a held-open `/fate/live` SSE
  stream is torn down between tests. `vitest.config.ts`'s `onUnhandledError`
  drops exactly that one message. Tracked in
  [#20](https://github.com/kamp-us/phoenix/issues/20) — a green summary with a
  `✗` exit is that, not a real failure.
- **No Vitest `retry` on integration tests.** The harness owns per-request
  retries at the right layer; a test-level retry re-enters `seedTerm`, whose
  process-level dedup then reports `created: false` and breaks the assertions
  it retries.
- **D1 create/destroy pressure is managed structurally, not capped.** ADR 0104's
  shared stage is the mitigation ADR 0082 deferred: the per-run stage count is
  ~7, uncapped parallelism no longer storms the CF registry. If the dedicated
  set grows, prefer migrating files to the shared stage (with `nsToken`
  namespacing) over re-introducing a fork cap.

## Citations

- `apps/web/tests/integration/_integration.ts` — both lifecycles, the stage
  derivation, the warm probes, `deployTransientRetry`.
- `apps/web/tests/integration/_global-setup.ts` — the run-scoped shared deploy.
- `apps/web/tests/integration/_stage-name.ts` — `stageName` / `sharedStageName`
  / `nsToken` (unit-pinned in `_stage-name.unit.test.ts`).
- `apps/web/tests/integration/_edge-ready.ts` — the ADR 0127 readiness primitive.
- `apps/web/tests/integration/_harness.ts` — the HTTP + setup-D1 client surface.
- `apps/web/worker/env.ts` — `resolveStateMode`, the dev-vs-deploy state-store
  selector.
- `apps/web/vitest.config.ts` — projects, pools, parallelism, `forceRerunTriggers`.
- `alchemy@2.0.0-beta.59` — `src/Test/Core.ts` (`MakeOptions`: `stage` defaults
  `"test"`, `state` defaults `localState`, `dev` from `ALCHEMY_DEV`),
  `src/Test/Vitest.ts` (`make`, `test.provider`, `afterAll.skipIf`),
  `src/Test/Bun.ts`.

## See also

- [ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md) — the two
  test tiers + the `Test.make` integration substrate.
- [ADR 0104](../.decisions/0104-two-mode-integration-test-tier.md) — the
  shared-vs-dedicated two-mode split this doc describes.
- [ADR 0127](../.decisions/0127-unified-edge-readiness-primitive.md) — the one
  cold-edge readiness primitive.
- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — what the stack the
  harness deploys actually declares.
- [ADR 0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) — the dev model
  (real remote D1 even in dev).
- [effect-testing.md](./effect-testing.md) — the two-tier picker + unit-tier
  seam substitution (the integration path there redirects here).
