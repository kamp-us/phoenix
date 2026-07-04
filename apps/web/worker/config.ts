/**
 * The worker's `effect/Config` surface (see
 * `.patterns/worker-environment-pattern.md`). Each var is declared ONCE as a
 * `Config` constant, and its binding NAME is declared ONCE in `ENV_BINDINGS`
 * below — so neither the value nor the name can drift across the bind↔read seam:
 * the `env:` block (`index.ts`) binds it (alchemy resolves it from deploy-time
 * `process.env`), and runtime code reads it via `yield* AppConfig` off the
 * ConfigProvider alchemy auto-wires from the bound env.
 *
 * The deploy-time state-store selector stays in `env.ts` — it runs in the
 * alchemy CLI process, a different moment from these runtime reads.
 */
import * as Config from "effect/Config";
import {DEFAULT_ENVIRONMENT, ENVIRONMENTS, type Environment} from "./environment.ts";

/**
 * The worker env binding NAMES, declared once (#1432). Both halves of the bind↔read
 * seam reference these: the `Config` constructors below read under them, and the
 * `env:` block in `index.ts` binds under them as computed keys (via `envBindings`),
 * so each name lives in exactly ONE place. Key↔name drift is unrepresentable, not
 * merely caught — a rename here changes both the binding and the read in lockstep.
 *
 * The roster of CI-provisioned secrets (`BETTER_AUTH_SECRET` is the only worker
 * binding that overlaps it) is documented separately in the provisioner —
 * `infra/ci-credentials/github.ts` — because GitHub Actions and turbo can't import TS.
 */
export const ENV_BINDINGS = {
	environment: "ENVIRONMENT",
	betterAuthSecret: "BETTER_AUTH_SECRET",
	sentryDsn: "SENTRY_DSN",
} as const;

/**
 * The deploy environment — the deploy classes (ADR 0088), the taxonomy owned by
 * `environment.ts`. Non-redacted (→ `plain_text` binding), fail-closed: defaults to
 * "production" when unset, so a missing var closes every dev gate. `development` is local
 * `alchemy dev`; `preview` is a deployed per-PR stage on `*.kampusinfra.workers.dev`;
 * `production` is prod; `audit` is the isolated rite-audit stage (#1511).
 *
 * The `withDefault` is kept deliberately (#1432). Its job is fail-closed-to-prod for a
 * genuinely *unset* var (ADR 0088), NOT masking a name typo: with the binding name now
 * single-sourced via `ENV_BINDINGS.environment` there is no second name literal that can
 * drift, so the default can no longer hide a key↔name mismatch (there is none to hide).
 * A deploy-time *unknown* value still fails loud at the deploy gate (`environment.ts`
 * `UnknownEnvironmentError`, #1433).
 */
export const environment = Config.literals(ENVIRONMENTS, ENV_BINDINGS.environment).pipe(
	Config.withDefault(DEFAULT_ENVIRONMENT),
);

/** Re-exported from the taxonomy owner (`environment.ts`) for the runtime read sites. */
export type {Environment};

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
export const betterAuthSecret = Config.redacted(ENV_BINDINGS.betterAuthSecret);

/**
 * The Sentry DSN (ADR 0118), read as an OPTION so the worker Sentry path is inert
 * when unset — `Config.option` yields `None` and the request seam returns the base
 * fetch untouched (unlike `betterAuthSecret`, which is required and `orDie`s).
 *
 * NOT in `envBindings` below: the binding is added conditionally at deploy
 * (`index.ts` env block) only when a DSN is provisioned, so an unset DSN produces
 * NO binding at all — reading via `Config.option` then resolves `None`. Bound
 * `secret_text` (a redacted value) when present; read here as a plain string
 * because workerd exposes the binding as a string on `env` and the DSN is handed
 * verbatim to `@sentry/cloudflare`.
 */
export const sentryDsn = Config.string(ENV_BINDINGS.sentryDsn).pipe(Config.option);

/**
 * The Config-backed worker env bindings, keyed by their binding NAME (the computed keys
 * resolve from `ENV_BINDINGS`, so the key the worker binds under and the name the `Config`
 * reads under are the SAME literal). The `env:` block in `index.ts` spreads this in, so the
 * binding names are never restated there — a key↔name mismatch is impossible by
 * construction (#1432). `index.ts` adds the non-Config `Flagship` resource binding alongside.
 */
export const envBindings = {
	[ENV_BINDINGS.environment]: environment,
	[ENV_BINDINGS.betterAuthSecret]: betterAuthSecret,
};

/** The single yieldable read surface. `yield* AppConfig` returns `{ environment }`. */
export const AppConfig = Config.all({environment});
