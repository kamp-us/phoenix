/**
 * The phoenix alchemy stack (ADR 0026–0031). One Effect program that declares
 * the resources and deploys the worker. `alchemy deploy` runs it against the
 * Cloudflare API; `alchemy dev` runs it against a local workerd. There is no
 * `wrangler.jsonc`.
 *
 * Lives in the `@kampus/web` package (next to the worker it deploys) because
 * pnpm isolates `node_modules` — `alchemy`/`effect` resolve from here, not the
 * repo root. Paths in the worker's resource declarations (`migrationsDir`,
 * `assets`) are relative to this directory, the alchemy CLI's working dir.
 *
 * Yielding the `Phoenix` worker Tag deploys the worker; the worker's own init
 * phase (its `bind()` calls and DO Layers) tells alchemy which bindings, DOs, and
 * migrations to send — the stack does not re-declare them. The implementation is
 * the modular `.make()` Layer (the worker's `export default`, `PhoenixLive`),
 * which the stack provides so the Tag resolves (ADR 0028): splitting the worker
 * class from its `.make()` Layer lets it host the single unified `LiveDO`
 * (no DO cycle; ADR 0037).
 *
 * State selection follows ADR 0031 (local-first dev): `Alchemy.localState()` is
 * a file-based store needing only `FileSystem`/`Path` — no credentials, no
 * network — so `alchemy dev` boots fully offline. A real `alchemy deploy` uses
 * the Cloudflare-hosted store for reproducible shared state.
 *
 * The store is selected from the **dev-vs-deploy** signal, not `CI` (see
 * `resolveStateMode` in `worker/env.ts`): `CI` is set for BOTH the deploy workflow
 * and the integration-test job, so it can't tell a real deploy from a test run.
 * Only `alchemy dev` resolves to `localState()` (offline); a real `alchemy deploy`
 * — and the `Test.make` integration suite, which deploys to real remote Cloudflare
 * per ADR 0082 — uses the shared Cloudflare store. The selector runs synchronously
 * at module-eval, so it reads the dev signal off `process.env`
 * (`ALCHEMY_EXEC_OPTIONS.dev` / `ALCHEMY_DEV`) rather than the runtime
 * `AlchemyContext.dev` / `ALCHEMY_PHASE`, which are not yet in scope here.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {PhoenixDb} from "./worker/db/resources.ts";
import {resolveStateMode} from "./worker/env.ts";
import {isProductionDeploy} from "./worker/environment.ts";
import {
	authorshipLoopFlag,
	demoTargetingFlag,
	Flagship,
	panoDraftSaveFlag,
} from "./worker/features/flagship/resources.ts";
import {provisionEmailSending} from "./worker/features/pasaport/email-resources.ts";
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
		// Declare the demo targeting/rollout flag as IaC (epic #488, #511): yield the
		// Flagship app for its server-generated `appId`, then ensure the flag exists.
		// Yielding the same app resource the worker `bind()`s is idempotent.
		const flagship = yield* Flagship;
		yield* demoTargetingFlag(flagship.appId);
		// The pano taslak (draft-save) dark-ship flag, default-off (#746).
		yield* panoDraftSaveFlag(flagship.appId);
		// The earned-authorship loop (çaylak→yazar) dark-ship flag, default-off
		// (#1204, epic #1202) — the single seam the authorship-loop epic gates behind.
		yield* authorshipLoopFlag(flagship.appId);
		// Email Sending IaC (ADR 0101) — the `send.kamp.us` sending subdomain, declared
		// PRODUCTION-ONLY: a preview/dev deploy uses the `EmailSenderLog` sink and never
		// provisions a per-stage email subdomain (reputation isolation + no waste). The
		// `send_email` worker binding follows the same gate — its prod adapter `bind()`s
		// the descriptor at init, dev/preview never reference it.
		if (isProductionDeploy(process.env)) {
			yield* provisionEmailSending;
		}
		// Surface this stage's D1 uuid (+ account) in the compiled output so the
		// integration harness reads the deployed id directly instead of reconstructing
		// the physical name and prefix-matching the CF list API (#692). Yielding the
		// same `D1Database` resource the worker `bind()`s is idempotent (same as Flagship
		// above); its resolved output carries `databaseId`/`accountId` (alchemy
		// `Cloudflare.D1Database`, output `{databaseId, accountId, …}`).
		const db = yield* PhoenixDb;
		// `domains` is the Custom Domain(s) bound to the worker (#594) — production-only:
		// `phoenix.kamp.us` on a prod deploy, and empty for every non-prod stage (preview,
		// named dev, and ephemeral integration `it-*` stages all attach no domain, so their
		// `worker.url` stays `*.workers.dev`). See `customHostname` for why per-stage
		// subdomains were dropped (un-provisioned TLS broke integration, #983).
		return {
			url: worker.url,
			domains: worker.domains,
			databaseId: db.databaseId,
			accountId: db.accountId,
		};
	}).pipe(Effect.provide(PhoenixLive)),
);
