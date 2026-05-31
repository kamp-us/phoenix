# Integration test harness — alchemy/Test deploy + black-box HTTP

Phoenix's integration tests deploy the **real alchemy stack** to a local
workerd (offline, file-based state) and assert **black-box over HTTP**
against the deployed worker URL. No miniflare, no `@cloudflare/vitest-pool-workers`,
no `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`. The harness
is the path every integration test takes.

This pattern supersedes the miniflare-based integration recipe in
[effect-testing.md](./effect-testing.md) (which is the legacy reference
and is being retired). The new path is the only path for product code that
touches D1, the DOs, or the fate seam.

## The two shapes alchemy offers

Alchemy's `alchemy/Test/Vitest` module provides `Test.make(options)` →
`{test, beforeAll, afterAll, deploy, destroy, ...}` — the stock alchemy
test API. The typical shape is:

```ts
import * as Test from "alchemy/Test/Vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import Stack from "../../alchemy.run.ts";

const {test, beforeAll, afterAll, deploy, destroy} = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));        // returns a lazy accessor
afterAll.skipIf(!process.env.CI)(destroy(Stack)); // standard cleanup gate

test("hits the deployed worker", () =>
  Effect.gen(function* () {
    const out = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${out.url}/api/health`);
    // ...
  }),
);
```

In this form, every test Effect has `HttpClient.HttpClient` in scope
automatically; you hit the deployed worker URL with the stock effect HTTP
client.

**Phoenix doesn't use this form, and it's worth knowing why.** The
alchemy dev sidecar (`@distilled.cloud/cloudflare-runtime`) brings up a
Node-side LoopbackServer that the worker calls back into for D1/storage.
Inside a Vitest **pool worker** (forks or threads), that loopback loses a
`net.Server` address race and the whole worker becomes unreachable — and
the failure is an uninterruptible hang, so `beforeAll`'s retry can't
recover. The sidecar comes up cleanly only in Vitest's **main process**
(the same context the `alchemy` CLI runs in). `Test.make` runs
`beforeAll(deploy(Stack))` inside the pool, so it hits the race.

Phoenix's shape:

- **`tests/integration/_global-setup.ts`** runs in the Vitest main
  process and uses `alchemy/Test/Core` (`Core.deploy` + `Core.run`) to
  deploy the stack once. The deployed URL is published via
  `process.env.PHOENIX_TEST_URL`. Teardown calls `Core.destroy` + closes
  the scope. See the file header for the full LoopbackServer rationale.
- **`tests/integration/_harness.ts`** runs inside the pool. `harness()`
  reads `PHOENIX_TEST_URL` and exposes a thin HTTP client (`fate`,
  `fateBatch`, `signUp`, `seedTerm`, `openSse`, `liveControl`) that hits
  the deployed worker. The harness does **not** deploy; it just reads the
  URL the global setup published.
- **The vitest project** runs `pool: "forks"`, `maxWorkers: 1`,
  `isolate: false`, `fileParallelism: false`. One long-lived fork, no
  per-file isolation, the workerd sidecar lives in the main process.

The two-process split is the workaround. The contract that matters at the
test-author seam — "deploy a real stack, hit it over HTTP, tear it down"
— is the same as `Test.make`. Future maintainers can collapse this to
`Test.make` if the LoopbackServer race is fixed upstream.

## The harness contract

Test files start with:

```ts
import {describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness(); // reads PHOENIX_TEST_URL — does NOT deploy

describe("fate seam — /fate", () => {
  it("health resolves data produced by an Effect service method", async () => {
    const result = await h.fate({
      kind: "query",
      name: "health",
      select: ["status", "definitions"],
    });
    expect(result.ok).toBe(true);
    // ...
  });
});
```

Vitest's stock `it` + `expect` (not `it.effect` + `assert`) is the right
shape: tests are HTTP-only and run as plain async functions; no Effect
runtime, no `Effect.runPromise`. The `Effect`-aware path inside the worker
is exercised through its observable HTTP behavior, not by yielding to
Effects in the test body.

The harness API (`apps/web/tests/integration/_harness.ts`):

| Method | What it does |
|---|---|
| `h.url()` | Read `PHOENIX_TEST_URL`. Throws with a clear message if unset. |
| `h.req(path, init?)` | `fetch(url + path, init)`; retries transient connection failures. |
| `h.json(path, body, cookie?)` | POST JSON (sets `content-type`, dev `origin`, optional `cookie`). |
| `h.fate(op, opts?)` | POST one fate operation; return its single result. |
| `h.fateBatch(ops, opts?)` | POST several fate operations; return all results in order. |
| `h.signUp(email, password, name)` | Sign up via `/api/auth/sign-up/email`; return `{userId, cookie}`. |
| `h.seedTerm(...)` | Seed a sözlük term + definitions. Seeding is out-of-band (a direct-D1 script), not a runtime route. |
| `h.openSse(connectionId, cookie)` | Open the live SSE stream. |
| `h.liveControl(connectionId, ops, cookie)` | POST control messages (subscribe / unsubscribe). |

`readFrame`/`readEvent`/`frameData` (also exported) parse the SSE wire on
the test side.

## What lives where

- **The deploy** — `tests/integration/_global-setup.ts`. Uses
  `Core.deploy` + `Core.run` over a `Scope` that survives the run; calls
  `installLocalhostDns()` so `*.localhost` resolves (macOS doesn't
  resolve `*.localhost` by default, and `alchemy dev` exposes the worker
  vhost-routed). Forces `Alchemy.localState()` even under CI — the test
  stack is ephemeral and must not touch the shared Cloudflare-hosted
  store. Injects placeholder `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`
  when absent so the suite is self-contained (no `alchemy login`, no
  profile, no network).
- **The DNS shim** — `tests/integration/_localhost-dns.ts`. A small
  `node:dns` patch so `fetch("http://phoenix.localhost:<port>/…")`
  resolves. **Not** a network emulator — alchemy's bundled
  `LocalhostDns` was retired in ADR 0032; this shim replaces it.
- **The harness** — `tests/integration/_harness.ts`. The HTTP client
  surface above. Runs in the test pool fork.
- **The test files** — `tests/integration/*.test.ts`. Black-box only:
  call `h.fate(...)`, `h.json(...)`, etc.; assert on the response.

## `test.provider` for provider-lifecycle tests

`alchemy/Test/Vitest`'s `test.provider(name, fn)` runs a test against a
scratch in-memory stack — useful for testing a provider implementation in
isolation (does `create`/`update`/`delete` round-trip? does the diff
work?). Phoenix doesn't author providers today, so this isn't used in the
suite. If a future phoenix-owned provider lands, `test.provider` is the
right shape for its tests.

## Bun vs Vitest

`alchemy/Test/Bun` ships the same `make(...)` → `{test, beforeAll, ...}`
API over `bun:test`. Phoenix uses Vitest (`apps/web/vitest.config.ts`)
because the project already has Vitest projects (integration + unit) and
the unit project drives `@effect/vitest`'s `it.effect`. There's no reason
to mix runners.

## The unit-test project

The same `vitest.config.ts` defines a `unit` project for tests that
**don't** need a deployed worker — pure helpers, the `Drizzle` service
contract, the fate bridge over a `node:sqlite` D1, the Effect-DO instance
builders over a DO-state fake. Unit tests are colocated as
`<module>.test.ts` under `worker/**` and `src/**`. The `live-instance.ts`
factory pair is the load-bearing example: it's a pure factory that takes
a `DurableObjectState["Service"]` + a sibling resolver, so
`live-instance.test.ts` drives it with fakes for both and never touches
workerd.

## Citations

- `apps/web/tests/integration/_global-setup.ts` — the deploy/teardown,
  the LoopbackServer rationale, the local-state forcing.
- `apps/web/tests/integration/_harness.ts` — the HTTP harness API.
- `apps/web/tests/integration/seam.test.ts` — a minimal black-box test
  (health + an unauthorized error).
- `apps/web/tests/integration/fate-live.test.ts` — SSE black-box.
- `apps/web/vitest.config.ts` — projects, pool, isolate, sequence.

## See also

- [alchemy-stack-deploy.md](./alchemy-stack-deploy.md) — what the stack
  the harness deploys actually declares.
- [ADR 0031](../.decisions/0031-local-first-dev-state.md) — local-first
  state for dev/test.
- [ADR 0032](../.decisions/0032-alchemy-beta45-and-dev-model.md) — the
  upgrade that retired `LocalhostDns` (replaced by the `_localhost-dns.ts`
  shim).
- [effect-testing.md](./effect-testing.md) — the legacy miniflare recipe
  (kept for the unit-test guidance; the integration path there is
  retired).
