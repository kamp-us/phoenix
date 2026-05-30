# Worker environment

How runtime code reads the worker's env, and why it isn't a `Config` or a
service. The short answer: `yield* Cloudflare.WorkerEnvironment` and cast once to
`Record<string, string | undefined>`. The `env:` literal on the worker is
deploy-time wiring; reading a value at runtime is a separate, plainer thing.

## Reading env at runtime

`Cloudflare.WorkerEnvironment` is the Tag alchemy provides at worker scope for
the bound `env`. It comes back untyped, so cast it once at the read site:

```ts
const env = yield* Cloudflare.WorkerEnvironment;
const record = env as unknown as Record<string, string | undefined>;
const environment = record.ENVIRONMENT; // "development" | "production" | undefined
```

`ENVIRONMENT` is the only env var phoenix reads this way. `BetterAuthLive`
(`features/pasaport/better-auth-live.ts`) reads it to derive better-auth's
`baseURL` / `trustedOrigins` (dev explicit, prod infer-from-Host); the health
route (`http/health.ts`) reads it to report which deploy answered. One cast per
read site, no shared typed wrapper.

## Why not `Config`

`Config` is the wrong tool for `ENVIRONMENT`. When a `Config` value is resolved
inside a worker's **Init** phase, alchemy binds it as a `secret_text` binding —
the path for secrets (API keys, signing secrets). `ENVIRONMENT` is **plain
policy config**, not a secret: it steers dev gates and cookie-origin handling and
is visible in plaintext anyway. Binding it as `secret_text` would misrepresent
it and route it through the secret-provisioning machinery for no reason. Read it
as a plain binding via `WorkerEnvironment` instead. (Secrets that genuinely are
secret — the better-auth session key — use `Random(...)`, not the env block; see
[better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md).)

## Why no `Context.Service` / `AppConfig`

There is no `AppConfig` service wrapping the env. A one-field policy var read at
two sites doesn't earn a service: a service is a seam for swappable behavior or
captured dependencies, and `ENVIRONMENT` is neither — it's a string the platform
already hands you through `WorkerEnvironment`. Wrapping it would add a Layer to
wire, a Tag to provide, and a test double to maintain, all to forward one string.
The cast-at-read-site keeps the indirection at zero.

## Deploy-time literal vs runtime read

Two different moments, kept separate:

- **Deploy-time `env:` literal.** The worker's `env: { ENVIRONMENT }` block
  (`index.ts`) is evaluated in the alchemy CLI process at deploy time and records
  the binding's value for the Cloudflare API. `ENVIRONMENT` resolves from the
  deploy-time `process.env`, defaulting to `"production"` (fail-closed) when
  unset. This is the only thing in the block — no `BETTER_AUTH_*` URLs, no
  `phoenixEnvBindings` indirection ([ADR 0031](../.decisions/0031-local-first-dev-state.md)).
- **Runtime read.** At request time the worker reads the bound value back via
  `yield* Cloudflare.WorkerEnvironment` + the cast. The literal sets it; the read
  consumes it; nothing in between.
