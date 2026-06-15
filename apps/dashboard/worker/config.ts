/**
 * The worker's `effect/Config` surface (see
 * `.patterns/worker-environment-pattern.md`). Each var is declared ONCE as a
 * `Config` constant: the `env:` block (`index.ts`) binds it (alchemy resolves it
 * from deploy-time `process.env`), and runtime code reads it via `yield* AppConfig`
 * off the ConfigProvider alchemy auto-wires from the bound env.
 *
 * The deploy-time state-store selector stays in `env.ts` — it runs in the alchemy
 * CLI process, a different moment from these runtime reads.
 */
import * as Config from "effect/Config";

/**
 * The deploy environment. Non-redacted (→ `plain_text` binding), fail-closed:
 * defaults to "production" when unset, so a missing var closes every dev gate.
 */
export const environment = Config.literals(["development", "production"], "ENVIRONMENT").pipe(
	Config.withDefault("production"),
);

/** The single yieldable read surface. `yield* AppConfig` returns `{ environment }`. */
export const AppConfig = Config.all({environment});
