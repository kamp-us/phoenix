/**
 * The dashboard alchemy stack (ADR 0026–0031, 0056). Its OWN `Alchemy.Stack` —
 * an independent second worker, NOT squeezed into apps/web's stack: phoenix is
 * multi-app/multi-worker, each app a workspace package with its own stack and
 * deploy stage (ADR 0056). The account-global Cloudflare state store and the four
 * CI secrets are reused (no second bootstrap).
 *
 * Lives in `@phoenix/dashboard` (next to the worker it deploys) because pnpm
 * isolates `node_modules` — `alchemy`/`effect` resolve from here. Paths in the
 * worker's resource declarations (`assets`) are relative to this directory, the
 * alchemy CLI's working dir.
 *
 * State selection follows ADR 0031 (local-first dev): `Alchemy.localState()` is a
 * file-based store needing only `FileSystem`/`Path` — no credentials, no network —
 * so `alchemy dev` boots fully offline. A real `alchemy deploy` uses the
 * Cloudflare-hosted store. The store is selected from the dev-vs-deploy signal,
 * not `CI` (see `resolveStateMode` in `worker/env.ts`).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {resolveStateMode} from "./worker/env.ts";
import DashboardLive, {Dashboard} from "./worker/index.ts";

export default Alchemy.Stack(
	"dashboard",
	{
		providers: Cloudflare.providers(),
		state:
			resolveStateMode(process.env) === "cloudflare" ? Cloudflare.state() : Alchemy.localState(),
	},
	Effect.gen(function* () {
		const worker = yield* Dashboard;
		return {url: worker.url};
	}).pipe(Effect.provide(DashboardLive)),
);
