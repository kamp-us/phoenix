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
	authorshipLoopFlag,
	bildirimFlag,
	demoTargetingFlag,
	Flagship,
	funnelReadoutFlag,
	modQueueFlag,
	optimisticDefinitionAddFlag,
	optimisticDefinitionDeleteFlag,
	optimisticEditsFlag,
	panoDraftSaveFlag,
	panoOptimisticCommentAddFlag,
	panoOptimisticCommentDeleteFlag,
	panoOptimisticPostDeleteFlag,
	panoOptimisticSubmitFlag,
	reactionsFlag,
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
		// The optimistic post.submit (feed root-list insert) containment flag,
		// default-off (#1676, epic #1637).
		yield* panoOptimisticSubmitFlag(flagship.appId);
		// The earned-authorship loop (çaylak→yazar) dark-ship flag, default-off
		// (#1204, epic #1202) — the single seam the authorship-loop epic gates behind.
		yield* authorshipLoopFlag(flagship.appId);
		// The conversion-funnel readout dark-ship flag, default-off (#1589) — the
		// founder/mod tier-count surface gates behind this key until a human release.
		yield* funnelReadoutFlag(flagship.appId);
		// The optimistic in-place content-edit dark-ship flag, default-off (#1675,
		// epic #1637) — post/comment/definition edits pass an optimistic payload only
		// behind this key until a human release.
		yield* optimisticEditsFlag(flagship.appId);
		// The optimistic post.delete dark-ship flag, default-off (#1677, epic #1637) —
		// gates the instant-feed-removal delete flow until a human release.
		yield* panoOptimisticPostDeleteFlag(flagship.appId);
		// The optimistic comment.add dark-ship flag, default-off (#1678, epic #1637) —
		// gates the instant nested-thread insert (ADR 0125 A1) until a human release.
		yield* panoOptimisticCommentAddFlag(flagship.appId);
		// The optimistic comment.delete dark-ship flag, default-off (#1680, epic #1637)
		// — gates the reply-aware leaf-drop / tombstone delete (ADR 0125 D1) until release.
		yield* panoOptimisticCommentDeleteFlag(flagship.appId);
		// The optimistic definition.add dark-ship flag, default-off (#1679, epic #1637)
		// — gates the nested-connection client-append (ADR 0125) until a human release.
		yield* optimisticDefinitionAddFlag(flagship.appId);
		// The bildirim (notification system) dark-ship flag, default-off (#1694, epic
		// #1666) — the single seam the whole notification surface gates behind.
		yield* bildirimFlag(flagship.appId);
		// The optimistic definition.delete dark-ship flag, default-off (#1681, epic
		// #1637) — gates the nested-connection edge-drop (ADR 0125 D1) until a human
		// release.
		yield* optimisticDefinitionDeleteFlag(flagship.appId);
		// The moderation-queue raporlar surface dark-ship flag, default-off (#1701) —
		// the moderator-only queue view inside /divan gates behind this key.
		yield* modQueueFlag(flagship.appId);
		// The reactions (emoji tepki) dark-ship flag, default-off (#1863, epic #1840) —
		// the single seam the whole reaction feature gates behind until a human release.
		yield* reactionsFlag(flagship.appId);
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
