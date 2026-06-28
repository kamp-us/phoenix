# Worker environment

How runtime code reads the worker's env: one `effect/Config` surface. A var is
declared ONCE as a `Config` constant, and its binding NAME is declared ONCE in
`ENV_BINDINGS` — so neither the value nor the name drifts across the bind↔read
seam (#1432). Never `yield* Cloudflare.WorkerEnvironment` raw, never cast.

## The surface

`worker/config.ts`. The binding NAMES live in one `as const`, `ENV_BINDINGS`, that
both the `Config` constructors and the `env:` block reference — so a name string is
written exactly once. Each var is one `Config` constant; `AppConfig = Config.all`
aggregates them into the single yieldable read. The `ENVIRONMENT` taxonomy itself
(the three classes, the `Environment` type, the `isProduction` gate, the
`stage → ENVIRONMENT` map) is owned by [`worker/environment.ts`](../apps/web/worker/environment.ts)
— the single module the deploy gates and the runtime `Config` both reuse (ADR 0088,
#1433), so `config.ts` imports the literal set rather than re-spelling it:

```ts
import * as Config from "effect/Config";
import {DEFAULT_ENVIRONMENT, ENVIRONMENTS, type Environment} from "./environment.ts";

// The binding NAMES, declared once. The Config constructors read under these and
// the env: block binds under these (computed keys), so name drift is unrepresentable.
export const ENV_BINDINGS = {
	environment: "ENVIRONMENT",
	betterAuthSecret: "BETTER_AUTH_SECRET",
} as const;

// One constant per var. Non-redacted → plain_text binding, fail-closed default.
// Three deploy classes (ADR 0088): local `development`, deployed `preview`, `production`.
export const environment = Config.literals(ENVIRONMENTS, ENV_BINDINGS.environment).pipe(
	Config.withDefault(DEFAULT_ENVIRONMENT),
);

// The Config-backed bindings keyed by their NAME — index.ts spreads this into env:.
export const envBindings = {
	[ENV_BINDINGS.environment]: environment,
	[ENV_BINDINGS.betterAuthSecret]: betterAuthSecret,
};

// The single read surface. Add a var: a name in ENV_BINDINGS + a const + a key here.
export const AppConfig = Config.all({environment});
```

## Binding it

The worker's `env:` block (`index.ts`) spreads `envBindings`, so the names are
never restated there — the binding key and the `Config` read both resolve from the
SAME `ENV_BINDINGS` literal, making a key↔name mismatch a structural impossibility,
not a runtime hazard (#1432):

```ts
env: {...envBindings, FLAGS: FlagshipResource},
```

Per-key (a spread of name-keyed entries) — not `env: AppConfig` — because alchemy's
binding model maps each `env` key to one native binding; a `Config.all` aggregate has
no single binding name. At deploy time alchemy resolves each `Config` from the
deploy-time `process.env` (`deploy.yml` sets `production` for the prod stage and
`preview` for every per-PR stage, the `dev:worker` script sets `development`, default
`production`) and binds it.

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
`customHostname`. These run in the alchemy CLI process over `process.env` at
deploy time — a different moment from the runtime `Config` reads, with no
`Config` equivalent (the state store is chosen before any worker exists).

## The `ENVIRONMENT` taxonomy is owned in one place

The `development | preview | production` taxonomy is read at THREE moments — the
worker runtime (via the `Config` above), the alchemy CLI at deploy time (over
`process.env`), and `.github/workflows/deploy.yml` (node strips its types). So it
lives in a pure, dependency-free module, [`worker/environment.ts`](../apps/web/worker/environment.ts),
not duplicated per site (ADR 0088, #1433):

- `isProduction(env: Environment)` — the ONE fail-closed prod gate; every TS site
  (`customHostname`, `emailSenderLayerFor`, `alchemy.run.ts`'s email/domain branches)
  calls it instead of an inline `=== "production"`.
- `isProductionDeploy(process.env)` — the deploy-time gate over `process.env.ENVIRONMENT`;
  fail-LOUD on a non-empty unknown value (throws `UnknownEnvironmentError`) so a CI
  misconfiguration (e.g. emitting the stage spelling `prod`) fails the deploy instead of
  silently downgrading to non-prod (the ADR 0092 fail-closed posture).
- `environmentForStage(stage)` — the single owner of the `prod`→`production` map;
  `deploy.yml` invokes it under node (`environmentForStage(process.env.STAGE)`) rather than
  inlining the spelling in a YAML expression.
