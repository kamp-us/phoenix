/**
 * The worker's deploy-time helper — the state-store selector
 * (`resolveStateMode`/`isOfflinePath`) — runs in the alchemy CLI process at
 * deploy time, over `process.env`.
 *
 * `worker/index.ts` declares the worker's `env` block, which is evaluated in the
 * alchemy CLI process at deploy time — so `process.env` here is the *deploy-time*
 * environment (`alchemy deploy` on CI / from an `--env-file`, or the offline
 * `alchemy dev` / Vitest loop), not the worker runtime.
 *
 * The `ENVIRONMENT` binding itself is now an `effect/Config` constant in
 * `config.ts` (referenced per-key by the `env:` block and read at runtime via
 * `yield* AppConfig`); alchemy resolves it from the deploy-time `process.env`
 * with the same fail-closed default. This file keeps only the state-store
 * selector (`resolveStateMode`/`isOfflinePath`), which has no `Config`
 * equivalent — `alchemy.run.ts` calls it before any worker env is bound.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The one field of alchemy's `ALCHEMY_EXEC_OPTIONS` blob the selector reads. The
 * blob is an untyped trust boundary (an env-var JSON string set by the alchemy
 * CLI), so it's decoded at the boundary rather than asserted with a cast.
 */
const ExecOptions = Schema.Struct({dev: Schema.optional(Schema.Unknown)});
const decodeExecOptions = Schema.decodeUnknownOption(ExecOptions);

/** The subset of the deploy-time process env the selector reads. */
export interface DeployEnvInput {
	readonly ENVIRONMENT?: string | undefined;
	readonly CI?: string | undefined;
	readonly VITEST?: string | undefined;
	/**
	 * The alchemy `dev` flag, exclusively for `alchemy dev` (the offline local
	 * workerd loop). The `dev` CLI command spawns its exec subprocess with this
	 * JSON blob in the environment; `deploy`/`plan`/`destroy` run inline and never
	 * set it. So a parsed `dev: true` here is the genuine alchemy dev signal —
	 * available synchronously at module-eval, before any Effect/`AlchemyContext`
	 * is in scope.
	 *
	 * @see node_modules/alchemy/lib/Cli/commands/dev.js — sets `ALCHEMY_EXEC_OPTIONS`
	 */
	readonly ALCHEMY_EXEC_OPTIONS?: string | undefined;
	/**
	 * A coarser dev override (`"1"`/`"true"`) that alchemy's own test harness
	 * honors via `Core.resolveDev`. Treated as a dev signal here too for parity.
	 *
	 * @see node_modules/alchemy/lib/Test/Core.js — `resolveDev`
	 */
	readonly ALCHEMY_DEV?: string | undefined;
}

/** Which alchemy state store the stack should use. */
export type StateMode = "local" | "cloudflare";

/**
 * Is this an offline alchemy path — `alchemy dev` or the Vitest integration
 * harness — where the file-based `localState()` is correct and required?
 *
 * Keyed off the **real dev-vs-deploy** signal, NOT `CI`. `CI` is set for BOTH
 * the deploy workflow and the test job, so it can't tell a real deploy from a
 * test run — the old `CI && !VITEST` heuristic therefore made a laptop
 * `alchemy deploy` (no `CI`) silently fall to local state, diverging from the
 * shared store. The genuine signals, all readable synchronously at module-eval
 * (before `AlchemyContext`/`ALCHEMY_PHASE` exist):
 *
 *   - `VITEST` — the integration harness must stay offline; it also forces its
 *     own `localState()` via `Core.run` options, so this is belt-and-suspenders.
 *   - alchemy's `dev` flag — `alchemy dev` spawns its exec subprocess with
 *     `dev: true` in `ALCHEMY_EXEC_OPTIONS`; `deploy` runs inline and never sets
 *     it. `ALCHEMY_DEV=1|true` is the coarser override the test harness honors.
 *
 * So a real `alchemy deploy` (dev unset) resolves to the shared store whether or
 * not `CI` is set, and only `dev`/Vitest stays local.
 */
const isOfflinePath = (env: DeployEnvInput): boolean => {
	if (env.VITEST) return true;

	const devOverride = env.ALCHEMY_DEV?.toLowerCase();
	if (devOverride === "1" || devOverride === "true") return true;

	if (env.ALCHEMY_EXEC_OPTIONS) {
		try {
			const parsed = decodeExecOptions(JSON.parse(env.ALCHEMY_EXEC_OPTIONS));
			if (Option.isSome(parsed) && parsed.value.dev === true) return true;
		} catch {
			// A malformed blob is not a dev signal — fall through to deploy (shared
			// store). Failing safe toward the shared store keeps collab/diff intact.
		}
	}

	return false;
};

/**
 * Resolve which state store the alchemy stack should use.
 *
 * Pure over an injected snapshot so the selector is unit-testable without
 * mutating the real `process.env`.
 */
export const resolveStateMode = (env: DeployEnvInput): StateMode =>
	isOfflinePath(env) ? "local" : "cloudflare";
