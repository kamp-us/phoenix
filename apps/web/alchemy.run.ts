/**
 * The phoenix alchemy stack (ADR 0026–0031). One Effect program that declares
 * the resources and deploys the worker. `alchemy deploy` runs it against the
 * Cloudflare API; `alchemy dev` runs it against a local workerd. There is no
 * `wrangler.jsonc`.
 *
 * Lives in the `@phoenix/web` package (next to the worker it deploys) because
 * pnpm isolates `node_modules` — `alchemy`/`effect` resolve from here, not the
 * repo root. Paths in the worker's resource declarations (`migrationsDir`,
 * `assets`) are relative to this directory, the alchemy CLI's working dir.
 *
 * Yielding the `Phoenix` worker Tag deploys the worker; the worker's own init
 * phase (its `bind()` calls and DO Layers) tells alchemy which bindings, DOs, and
 * migrations to send — the stack does not re-declare them. The implementation is
 * the modular `.make()` Layer (the worker's `export default`, `PhoenixLive`),
 * which the stack provides so the Tag resolves (ADR 0028): splitting the worker
 * class from its `.make()` Layer lets it host the two circular live-fan-out DOs.
 *
 * State selection follows ADR 0031 (local-first dev): `Alchemy.localState()` is
 * a file-based store needing only `FileSystem`/`Path` — no credentials, no
 * network — so `alchemy dev` boots fully offline. A real `alchemy deploy` uses
 * the Cloudflare-hosted store for reproducible shared state.
 *
 * The store is selected from the **dev-vs-deploy** signal, not `CI` (see
 * `resolveStateMode` in `worker/env.ts`): `CI` is set for BOTH the
 * deploy workflow and the integration-test job, so it can't tell a real deploy
 * from a test run. Only `alchemy dev` and the Vitest harness resolve to
 * `localState()` (offline); a real `alchemy deploy` always uses the shared store
 * whether or not `CI` is set. The selector runs synchronously at module-eval, so
 * it reads the dev signal off `process.env` (`ALCHEMY_EXEC_OPTIONS.dev` /
 * `ALCHEMY_DEV` / `VITEST`) rather than the runtime `AlchemyContext.dev` /
 * `ALCHEMY_PHASE`, which are not yet in scope here.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {resolveStateMode} from "./worker/env.ts";
import PhoenixLive, {Phoenix} from "./worker/index.ts";

export default Alchemy.Stack(
	"phoenix",
	{
		providers: Cloudflare.providers(),
		state:
			resolveStateMode(process.env) === "cloudflare" ? Cloudflare.state() : Alchemy.localState(),
	},
	Effect.gen(function* () {
		const worker = yield* Phoenix;
		return {url: worker.url};
	}).pipe(Effect.provide(PhoenixLive)),
);
