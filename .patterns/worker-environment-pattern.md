# Worker environment

How runtime code reads the worker's env: one `effect/Config` surface. A var is
declared ONCE as a `Config` constant; that same constant binds the worker's
`env:` block and answers the runtime read. Never `yield* Cloudflare.WorkerEnvironment`
raw, never cast.

## The surface

`worker/config.ts`. Each var is one `Config` constant; `AppConfig = Config.all`
aggregates them into the single yieldable read:

```ts
import * as Config from "effect/Config";

// One constant per var. Non-redacted → plain_text binding, fail-closed default.
// Three deploy classes (ADR 0088): local `development`, deployed `preview`, `production`.
export const environment = Config.literals(
	["development", "preview", "production"],
	"ENVIRONMENT",
).pipe(Config.withDefault("production"));

// The single read surface. Add a var: a const above + a key here.
export const AppConfig = Config.all({environment});
```

## Binding it

The worker's `env:` block (`index.ts`) references the SAME constant, per-key:

```ts
env: {ENVIRONMENT: environment},
```

Per-key — not `env: AppConfig` — because alchemy's binding model maps each `env`
key to one native binding; a `Config.all` aggregate has no single binding name.
At deploy time alchemy resolves the `Config` from the deploy-time `process.env`
(`deploy.yml` sets `production` for the prod stage and `preview` for every
per-PR stage, the `dev:worker` script sets `development`, default `production`)
and binds it.

**A non-redacted `Config` binds `plain_text`, not `secret_text`.** Source fact:
`alchemy/lib/Cloudflare/Workers/WorkerAsyncBindings.js` `toBinding` resolves a
`Config` to its inner value and recurses — a plain string lands at the `typeof
binding === "string"` → `plain_text` branch; only `Redacted.isRedacted(value)`
(i.e. `Config.redacted`) → `secret_text`. The `Worker.ts` doc comment that says
Config binds "`secret_text` regardless of the constructor used" is **wrong** —
the implementation routes by the resolved value's shape. So `ENVIRONMENT`, plain
policy config, correctly binds `plain_text`.

## Reading it

`yield* AppConfig` returns the resolved record. Works in BOTH the Init phase and
the runtime phase: alchemy auto-wires a `ConfigProvider` from the bound env at
worker scope (`WorkerBridge.js`: `ConfigProvider.fromUnknown(env)`), so the read
resolves off the same values the `env:` block bound.

```ts
const {environment} = yield* AppConfig.pipe(Effect.orDie);
const isLocalDev = environment === "development";
```

`Effect.orDie` because the only residual `ConfigError` is a value outside the
declared literals — a malformed env, unrecoverable — so it dies rather than
widening the consumer's error channel. The fail-closed `withDefault` already
covers the missing-var case (lands in `production`, closing every dev gate).

`ENVIRONMENT` is the only var phoenix reads this way today. `BetterAuthLive`
(`features/pasaport/better-auth-live.ts`) reads it to derive better-auth's
`baseURL` / `trustedOrigins` per deploy class (ADR 0088: `development` explicit
localhost, `preview` dynamic `allowedHosts` for its workers.dev origin,
`production` infer-from-Host) and gate the magic-link `console.log` to local
`development` only; the health route (`http/health.ts`) reads it to report which
deploy answered.

## The route requirement

A handler that `yield* AppConfig` surfaces a `ConfigProvider` requirement (an
`HttpRouter` route lifts it to a `Request<"Requires">` marker). It's discharged
at the app boundary at worker scope — alchemy provides the `ConfigProvider`, so
no per-request wiring is needed. Tests provide it explicitly:
`Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))`.

## Secrets

A genuine secret uses `Config.redacted("NAME")` (→ `secret_text` binding) or,
when alchemy state should be the source of truth, `Random(...)` instead of the
env block — the better-auth session key is minted by `Random`, never bound from
`env` (see [better-auth-with-plugins-on-d1.md](./better-auth-with-plugins-on-d1.md)).

## Deploy-time helpers stay separate

`worker/env.ts` keeps the deploy-time helpers — `resolveStateMode` /
`isOfflinePath` (the state-store selector `alchemy.run.ts` calls) and
`resolveDeployEnv`. These run in the alchemy CLI process over `process.env` at
deploy time — a different moment from the runtime `Config` reads, with no
`Config` equivalent (the state store is chosen before any worker exists).
