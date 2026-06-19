/**
 * The worker's `effect/Config` surface (see
 * `.patterns/worker-environment-pattern.md`). Each var is declared ONCE as a
 * `Config` constant used in two places, so binding and read never drift: the
 * `env:` block (`index.ts`) binds it (alchemy resolves it from deploy-time
 * `process.env`), and runtime code reads it via `yield* AppConfig` off the
 * ConfigProvider alchemy auto-wires from the bound env.
 *
 * The deploy-time state-store selector stays in `env.ts` — it runs in the
 * alchemy CLI process, a different moment from these runtime reads.
 */
import * as Config from "effect/Config";

/**
 * The deploy environment — three classes (ADR 0088). Non-redacted (→ `plain_text`
 * binding), fail-closed: defaults to "production" when unset, so a missing var
 * closes every dev gate. `development` is local `alchemy dev`; `preview` is a
 * deployed per-PR stage on `*.kampusinfra.workers.dev`; `production` is prod.
 */
export const environment = Config.literals(
	["development", "preview", "production"],
	"ENVIRONMENT",
).pipe(Config.withDefault("production"));

/**
 * The better-auth session-signing secret. Redacted → `secret_text` binding (a
 * `Config.redacted` resolves to a Cloudflare secret). Read at RUNTIME via
 * `yield* betterAuthSecret` (`better-auth-live.ts`).
 *
 * This must travel as a binding, NOT via `alchemy/Random`: `Random` is a
 * deploy-time resource with no value in the workerd isolate (`SECRET.text` is
 * `undefined` there), so the secret could never be read back at request time. No
 * default — REQUIRED at deploy, so a missing secret fails closed rather than
 * silently signing cookies with a blank key.
 */
export const betterAuthSecret = Config.redacted("BETTER_AUTH_SECRET");

/** The single yieldable read surface. `yield* AppConfig` returns `{ environment }`. */
export const AppConfig = Config.all({environment});
