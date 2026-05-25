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
 * Yielding `Phoenix` deploys the worker; the worker's own init phase (its
 * `bind()` calls and `DurableObjectNamespace` declarations) tells alchemy which
 * bindings, DOs, and migrations to send — the stack does not re-declare them.
 *
 * State selection follows ADR 0031 (local-first dev): `Alchemy.localState()` is
 * a file-based store needing only `FileSystem`/`Path` — no credentials, no
 * network — so `alchemy dev` boots fully offline. CI/deploy uses the
 * Cloudflare-hosted store for reproducible shared state.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Phoenix from "./worker/index.ts";

export default Alchemy.Stack(
	"phoenix",
	{
		providers: Cloudflare.providers(),
		state: process.env.CI ? Cloudflare.state() : Alchemy.localState(),
	},
	Effect.gen(function* () {
		const worker = yield* Phoenix;
		return {url: worker.url};
	}),
);
