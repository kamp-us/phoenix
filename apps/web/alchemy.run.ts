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
import {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {PhoenixDb} from "./worker/db/resources.ts";
import {resolveStateMode} from "./worker/env.ts";
import {isProductionDeploy} from "./worker/environment.ts";
import {
	bildirimFlag,
	demoTargetingFlag,
	edgeShellBootFlag,
	emailDeliveryAdminFlag,
	emailDeliveryNoticeFlag,
	Flagship,
	karmaGatesFlag,
	mecmuaFeedFlag,
	mecmuaPublicReadFlag,
	mecmuaWriteFlag,
	memberMuteFlag,
	optimisticDefinitionDeleteFlag,
	panoDraftSaveFlag,
	panoStampWaveFlag,
	profileCanvasFlag,
	reactionsFlag,
	sozlukStampWaveFlag,
	userAdminFlag,
	userBanFlag,
	userRoleAssignFlag,
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
		// The mecmua write-path dark-ship flag, default-off (#2497, epic #2467) — the
		// single seam mecmua.publish + mecmua.saveDraft gate behind until a human release.
		yield* mecmuaWriteFlag(flagship.appId);
		// The bildirim (notification system) dark-ship flag, default-off (#1694, epic
		// #1666) — the single seam the whole notification surface gates behind.
		yield* bildirimFlag(flagship.appId);
		// The optimistic definition.delete dark-ship flag, default-off (#1681, epic
		// #1637) — gates the nested-connection edge-drop (ADR 0125 D1) until a human
		// release.
		yield* optimisticDefinitionDeleteFlag(flagship.appId);
		// The reactions (emoji tepki) dark-ship flag, default-off (#1863, epic #1840) —
		// the single seam the whole reaction feature gates behind until a human release.
		yield* reactionsFlag(flagship.appId);
		// The karma-gated privileges dark-ship flag, default-off (#150, epic #41) — the
		// single seam the post-floor (≥ −4) + flag-floor (≥ 50) karma gates ride behind
		// until a human release.
		yield* karmaGatesFlag(flagship.appId);
		// The user ban/unban dark-ship flag, default-off (#970, epic #968) — the single
		// seam the ban mutations + admin read + moderator-UI controls gate behind, so an
		// unreleased ban can never refuse a real user's session until a human release.
		yield* userBanFlag(flagship.appId);
		// The platform role-assign dark-ship flag, default-off (#3522, ADR 0107) — the single
		// seam the `Admin.over(platform)`-gated `user.setRole` mutation gates behind, so an
		// unreleased role-grant can never mint a moderator until a human release.
		yield* userRoleAssignFlag(flagship.appId);
		// The admin email-delivery (failing-address) surface dark-ship flag, default-off
		// (#2692, epic #2687) — the single seam the emailDelivery.mark/clear mutations + the
		// emailDelivery.failing admin roll-up gate behind until a human release.
		yield* emailDeliveryAdminFlag(flagship.appId);
		// The failing-email membrane notice dark-ship flag, default-off (#2693, epic #2687)
		// — the seam the user-facing notice gates behind until a human release.
		yield* emailDeliveryNoticeFlag(flagship.appId);
		// The mecmua public-read dark-ship flag, default-off (#2498, epic #2467) — the
		// single seam the anon GET route + reader page gate behind until a human release.
		yield* mecmuaPublicReadFlag(flagship.appId);
		// The mecmua subscribed-author feed dark-ship flag, default-off (#2500, epic #2467) —
		// the single seam the mecmuaFeed root + subscribe/unsubscribe + feed page gate behind
		// until a human release.
		yield* mecmuaFeedFlag(flagship.appId);
		// The sözlük parallel-stamp-wave read-collapse dark-ship flag, default-off (#2709,
		// epic #2567) — the concurrency knob the definition reads' stamp wave passes: off ⇒
		// serial (today), on ⇒ one concurrent wave, until a human release.
		yield* sozlukStampWaveFlag(flagship.appId);
		// The pano parallel-stamp-wave read-collapse dark-ship flag, default-off (#2710,
		// epic #2567) — the pano sibling of the sözlük flag above: the concurrency knob the
		// thread/comment reads' stamp wave passes: off ⇒ serial (today), on ⇒ one concurrent
		// wave, until a human release.
		yield* panoStampWaveFlag(flagship.appId);
		// The kullanıcılar (user-roster) read-view dark-ship flag, default-off (#3200, admin
		// epic) — the single seam the `userAdmin.list` admin read + the `kullanıcılar` console
		// panel gate behind until a human release, so the roster ships dark (invisible `Denied`).
		yield* userAdminFlag(flagship.appId);
		// The edge-resolved shell-boot dark-ship flag, default-off (#2928, epic #2926, ADR
		// 0179) — the single seam the `window.__BOOT__` INJECTION ships behind (worker-first
		// routing is unconditional): off ⇒ the worker returns the untransformed ASSETS bytes,
		// byte-identical to today; on ⇒ `__BOOT__` injected, until a human release.
		yield* edgeShellBootFlag(flagship.appId);
		// The profile free-paint canvas (duvar) dark-ship flag, default-off (#3103, epic
		// #2035) — the single seam the fate read view + visitor render, owner enable/toggle
		// mutation, and paint/save surface gate behind until a human release, so the whole
		// profile-canvas feature ships dark.
		yield* profileCanvasFlag(flagship.appId);
		// The member-mute (sustur) write-path dark-ship flag, default-off (#3112, epic
		// #2035) — the single seam `mute.set` / `mute.remove` gate behind until a human
		// release, so the whole mute primitive ships dark.
		yield* memberMuteFlag(flagship.appId);
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
	}).pipe(
		Effect.provide(PhoenixLive),
		// `PhoenixLive` leaks a `RuntimeContext` requirement into this stack program:
		// beta.59 colors DO storage/RPC and the `send_email` binding's `.send` with
		// `RuntimeContext` (ADR 0124), and alchemy's `.make<Req>` type does not subtract
		// the ambient `RuntimeContext` it provides at the worker execution scope. This is
		// the same phantom-Req gap ADR 0124 discharges for the DO seam; `RuntimeContext`
		// is really supplied by alchemy at deploy/runtime, so `RuntimeContext.phantom`
		// (`Layer.empty`) erases the false requirement here without shadowing that real
		// provision. `Providers` then clears via the stack's `providers` config. Deploy
		// proof rides #1615.
		Effect.provide(RuntimeContext.phantom),
	),
);
