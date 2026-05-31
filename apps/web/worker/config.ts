/**
 * The worker's `effect/Config` surface — one yieldable read for every runtime
 * env var, and the per-var `Config` constants the worker's `env:` block binds.
 *
 * A var is declared ONCE as a `Config` constant; that same constant is used in
 * two places, so the binding and the read never drift:
 *
 *   1. The worker's `env:` block (`index.ts`) references it per-key
 *      (`env: { ENVIRONMENT: environment }`). At deploy time alchemy resolves the
 *      `Config` from the deploy-time `process.env` (CI sets `ENVIRONMENT=production`,
 *      the `dev:worker` script sets `development`, default `production`) and binds
 *      it on the worker. A non-redacted `Config` resolving to a plain string binds
 *      `plain_text` — see `.patterns/worker-environment-pattern.md`.
 *   2. Runtime code reads it via `yield* AppConfig`. Alchemy auto-wires a
 *      `ConfigProvider` from the bound `env` at worker scope (`WorkerBridge`), so
 *      the same provider answers the read in both Init and runtime phases.
 *
 * The deploy-time state-store selector (`resolveStateMode`/`isOfflinePath`)
 * stays in `env.ts` — it runs in the alchemy CLI process over `process.env`, a
 * different moment from these runtime reads.
 */
import * as Config from "effect/Config";

/**
 * The deploy environment. Non-redacted (→ `plain_text` binding), fail-closed:
 * defaults to "production" when unset, so a missing var closes every dev gate.
 * Gates the auth-layer dev flag (the magic-link token `console.log` and the
 * better-auth dev-URL derivation) and the health probe's reported environment.
 */
export const environment = Config.literals(["development", "production"], "ENVIRONMENT").pipe(
	Config.withDefault("production"),
);

/**
 * The better-auth session-signing secret. **Redacted → `secret_text` binding**
 * (a `Config.redacted` resolves to a Cloudflare secret, not `plain_text`).
 *
 * Read at RUNTIME via `yield* betterAuthSecret` (`better-auth-live.ts`), off the
 * `ConfigProvider` alchemy auto-wires from the bound worker env — the runtime
 * `Redacted` is registry-backed (minted by `Config.redacted` from the env
 * string), so `Redacted.value` unwraps it cleanly. This replaces the old
 * `alchemy/Random` resource path: `Random` is a deploy-time resource with no
 * value in the workerd runtime isolate (`SECRET.text` is `undefined` there), so
 * the secret could never be read back at request time — it must travel as a
 * binding. No default: the secret is REQUIRED at deploy (the `dev:worker` script
 * supplies a dev value; CI/prod supply the real one), so a missing secret fails
 * the deploy closed rather than silently signing cookies with a blank key.
 */
export const betterAuthSecret = Config.redacted("BETTER_AUTH_SECRET");

/**
 * The single yieldable read surface. `yield* AppConfig` returns `{ environment }`.
 * Add a future var by declaring its `Config` constant above and adding a key here.
 */
export const AppConfig = Config.all({environment});
