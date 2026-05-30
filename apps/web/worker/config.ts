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
 * Deploy-time helpers (`resolveDeployEnv`/`resolveStateMode`/`isOfflinePath`)
 * stay in `env.ts` — they run in the alchemy CLI process over `process.env`, a
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
 * The single yieldable read surface. `yield* AppConfig` returns `{ environment }`.
 * Add a future var by declaring its `Config` constant above and adding a key here.
 */
export const AppConfig = Config.all({environment});
