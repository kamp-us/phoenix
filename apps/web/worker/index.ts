/**
 * The single phoenix worker, on alchemy-effect (ADR 0026–0031).
 *
 * Modular `.make()` form (ADR 0028): `class Phoenix extends Cloudflare.Worker<
 * Phoenix, {}, ConnectionDO | TopicDO>()(id, props)` is the worker Tag (declaring
 * the two hosted live-fan-out DOs as its `Deps` contract), and the `export
 * default Phoenix.make(body)` Layer is the implementation. Splitting the two lets
 * the worker host the two circular DOs and provide their `.make()` Layers (the
 * inline-body form can't take a `Deps` type param). The body runs in two phases:
 * the init phase binds resources (D1 + the two DO namespaces) once per isolate;
 * the runtime phase
 * returns the `fetch` handler — an `HttpRouter` compiled with
 * `HttpRouter.toHttpEffect`. The SPA is served from the `assets` prop, with
 * `runWorkerFirst` keeping the worker-owned paths (`/api/*`, `/fate`, `/fate/*`)
 * from being intercepted by the SPA shell.
 *
 * This replaces `wrangler.jsonc` (bindings/DOs/migrations/assets/vars) and the
 * Hono `export default {fetch}` entry. The full HTTP surface is wired here via
 * `makeAppLive` (`http/app.ts`): `GET /api/health`, the fate data plane
 * (`POST /fate`), better-auth (`* /api/auth/*`), the dev-only admin seeders
 * (`* /api/admin/*`, gated by `adminAllowed`), and the live SSE route
 * (`* /fate/live` → ConnectionDO). The feature services live under
 * `worker/features/` and the fate bridge under `worker/fate/`.
 *
 * Dev vs prod for the SPA (ADR 0030): the `assets` + `runWorkerFirst` config
 * below is the *production* single-worker precedence — at the Cloudflare edge,
 * non-worker paths are answered by the asset server and the worker only sees the
 * `runWorkerFirst` globs. In the local dev loop `vite dev` serves the SPA (with
 * HMR) and proxies `/api` + `/fate*` to this worker (task 6); under bare
 * `alchemy dev` this worker is API-only, so a non-API path has no SPA to return.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {makeAdminLayer, makeFateLayer} from "./fate/layers.ts";
import {LiveConnections, LiveTopics} from "./fate/live-topics.ts";
import {makeAppLive} from "./http/app.ts";
import ConnectionDO, {ConnectionDOLive} from "./infra/connection-do.ts";
import {PhoenixDb} from "./infra/resources.ts";
import TopicDO, {TopicDOLive} from "./infra/topic-do.ts";
import {createDrizzle} from "./services/Drizzle.ts";
import {resolveDeployEnv} from "./shared/deploy-env.ts";
import {adminAllowed, type WorkerEnv} from "./shared/worker-env.ts";

// Resolved ONCE in the alchemy CLI process when this module is evaluated, so the
// worker's `env` block below is the deploy-time policy (fail-closed). See
// `shared/deploy-env.ts`: `ENVIRONMENT` defaults to "development" only when unset
// (a real deploy sets `ENVIRONMENT=production`, closing every dev gate), and a
// missing `BETTER_AUTH_SECRET` throws here on a real deploy rather than silently
// shipping the committed dev key.
const deployEnv = resolveDeployEnv(process.env);

export class Phoenix extends Cloudflare.Worker<
	Phoenix,
	// The worker's own RPC shape — empty: this worker exposes no callable RPC
	// surface, only `fetch` (which alchemy's `WorkerShape` always adds). `{}` is
	// the empty-shape sentinel alchemy's `MakeShape` collapses to that base
	// `{fetch}`; biome bans bare `{}` as a type, but here it is load-bearing (no
	// other type expresses "no extra shape" without forcing every key to `never`,
	// which `{fetch}` then fails to satisfy).
	// biome-ignore lint/complexity/noBannedTypes: alchemy's empty-RPC-shape sentinel
	{},
	// The two live-fan-out DOs this worker hosts — declared as its public `Deps`
	// contract (ADR 0028) so the worker can `yield*` their Tags in init and
	// provide their `.make()` Layers below.
	ConnectionDO | TopicDO
>()("phoenix", {
	main: import.meta.filename,
	env: {
		// Resolves from `process.env.ENVIRONMENT`, defaulting to "development"
		// only when unset (`shared/deploy-env.ts`). This is the single gate every
		// dev-only surface reads — keep it deploy-time-resolved, never a literal.
		ENVIRONMENT: deployEnv.ENVIRONMENT,
		// Dev runs behind the Vite proxy, so the worker sees `Host:
		// 127.0.0.1:<port>` rather than the browser origin. better-auth needs
		// the real browser origin to set/validate its cookie, so we hand it the
		// origin explicitly (ADR 0031 / `auth.ts`) instead of inferring from the
		// inbound Host. No `https://` here — that would flip the cookie `Secure`
		// flag and break `http://localhost` storage.
		BETTER_AUTH_URL: "http://localhost:3000",
		BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:5173",
		// `BETTER_AUTH_SECRET` is NOT here — a plain `env` var deploys as a
		// Cloudflare `plain_text` binding (readable in state, plan output, and the
		// dashboard). The session-signing secret is bound below via
		// `Alchemy.Secret` instead, which deploys it as encrypted `secret_text`
		// (no plain-text copy in the bundle, plan, or logs) while still surfacing
		// on `env.BETTER_AUTH_SECRET` at runtime for `Pasaport` to read.
	},
	assets: {
		// The built SPA shell. `vite build` (no `@cloudflare/vite-plugin`,
		// ADR 0030) emits the client directly into `dist/client`; the path is
		// relative to the alchemy CLI's working dir (`apps/web`). At the
		// Cloudflare edge the worker serves this via `assets` + `runWorkerFirst`
		// (below) with no proxy; the dev proxy in `vite.config.ts` exists only
		// for the two-process dev loop.
		directory: "./dist/client",
		config: {
			// The SPA shell answers any non-worker path; the worker-owned paths
			// are listed in `runWorkerFirst` so the asset server doesn't shadow
			// them (a missing entry returns the shell for GET and 405 for POST).
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/fate", "/fate/*"],
		},
	},
	compatibility: {flags: ["nodejs_compat"]},
	observability: {enabled: true},
}) {}

/**
 * The worker implementation Layer (modular `.make()` form, ADR 0028). Splitting
 * the class (a lightweight identity, with the two hosted live-fan-out DOs
 * declared in its `Deps` type param) from `.make()` lets the worker host
 * `ConnectionDO` + `TopicDO` and provide their `.make()` Layers without the
 * inline-body form's `InitReq extends WorkerServices | PlatformServices`
 * constraint — the DO Tags `yield*`-ed in init are dischargeable here.
 */
export default Phoenix.make(
	Effect.gen(function* () {
		// ── INIT PHASE (deploy time + once per isolate) ──
		// Bind the resources. At deploy time each call records the binding's
		// metadata for the Cloudflare API; at runtime it resolves the typed client.
		// Everything bound here is in scope for the worker's whole lifetime — task 2
		// builds the worker-level `Drizzle` + feature layers from `db`, and tasks 5
		// wire the live publish path through the two DO namespaces.
		const db = yield* Cloudflare.D1Connection.bind(PhoenixDb);
		const connections = yield* ConnectionDO;
		const topics = yield* TopicDO;

		// Bind the session-signing secret as encrypted `secret_text` rather than a
		// `plain_text` env var (see the `env` block above). The value is already
		// deploy-time-resolved and fail-closed by `resolveDeployEnv` (a real deploy
		// with no `BETTER_AUTH_SECRET` threw at module-eval; the offline dev/Vitest
		// loop falls back to the fixed non-secret), so we wrap that resolved string —
		// `Alchemy.Secret` only changes how it is *stored*, not how it is resolved.
		//
		// `Alchemy.Secret` is the alchemy-effect `Output` form — it registers a worker
		// `secret_text` binding (not a Cloudflare Secrets Store entry); at runtime its
		// value surfaces on `env.BETTER_AUTH_SECRET` (via `WorkerEnvironment`, below)
		// for `Pasaport` to read. The `yield*` (binding registration) is the
		// load-bearing effect; only the *returned accessor* is unused (`_`-prefixed):
		// resolving it here would re-read the binding at init time, which the offline
		// dev loop can't satisfy — binding it to a variable also discharges the
		// floating-effect diagnostic without that re-read.
		const _betterAuthSecret = yield* Alchemy.Secret(
			"BETTER_AUTH_SECRET",
			Redacted.make(deployEnv.BETTER_AUTH_SECRET),
		);

		// Each bound client stays load-bearing through its real use below: `db`
		// via `db.raw`, and `topics`/`connections` via the `liveLayer` closures'
		// `getByName(...)` calls — drop a `bind()`/`yield*` above and the type
		// checker fails at that usage, so an unwired binding is a compile error,
		// never a runtime `undefined`.

		// Build the worker-level service layers ONCE from the bound D1 (ADR 0029):
		// `conn.raw` is the underlying Cloudflare `D1Database`, handed to
		// `drizzle(raw, {schema})`; `Drizzle` + the feature services (`fateLayer`)
		// and the admin services (`adminLayer`) are constructed here and stay alive
		// for the isolate — the request/admin split (ADR 0012) as two layer sets
		// over one worker, not two `ManagedRuntime`s. The `/fate` route provides
		// only `Auth`/`RequestContext` per request; the admin seeders provide
		// `AdminAuth` (the env gate) per route.
		const raw = yield* db.raw;
		// `WorkerEnvironment` carries the worker's `env` vars, but the D1 client is
		// resolved through the bound `D1Connection` (`db.raw`), not as an `env.*`
		// binding. `PasaportLive` builds better-auth's drizzle adapter from
		// `env.PHOENIX_DB` (alchemy-drizzle-d1.md "better-auth on the same D1"), so
		// surface the bound `raw` there — the same D1 the data plane runs on.
		// The alchemy runtime `WorkerEnvironment` is an untyped record; overlay the
		// typed fields the worker actually injects/reads (`PHOENIX_DB` from the
		// bound D1, `ENVIRONMENT` widened to `string`) to recover a typed
		// `WorkerEnv` — no `as unknown as Env` laundering.
		const env: WorkerEnv = {
			...(yield* Cloudflare.WorkerEnvironment),
			PHOENIX_DB: raw,
			ENVIRONMENT: deployEnv.ENVIRONMENT,
		};
		const fateLayer = makeFateLayer(createDrizzle(raw), env);
		const adminLayer = makeAdminLayer(createDrizzle(raw));
		// Typed read off `WorkerEnv` (`shared/worker-env.ts`), not a `Record` cast:
		// the dev-only admin surfaces open only on `development`, fail-closed
		// otherwise.
		const allowAdmin = adminAllowed(env);

		// The live path (ADR 0028/0029): both DO namespaces are resolved ONCE in
		// init (`topics`/`connections`, above) and wrapped as worker-level services.
		//   - `LiveTopics.publish` fans a mutation's `live.*` out via typed RPC
		//     (`topics.getByName(\`topic:${key}\`).publish(msg)`) — no `env` lookup,
		//     no `idFromName`, no string-URL `stub.fetch`.
		//   - `LiveConnections` opens the SSE stream (forwarding the request to a
		//     connection's `fetch`) and drives subscribe/unsubscribe RPC, addressing
		//     connections by name (`connection:${id}`).
		// The cross-DO fan-out itself (topic→connection deliver, connection→topic
		// register) resolves the sibling Tag per call inside the DO RPC methods
		// (`infra/*-do.ts`), so a stub method that fans out carries that sibling Tag
		// plus the alchemy `Worker` binding service in `R`: `TopicDO.publish` →
		// `ConnectionDO | Worker`, `ConnectionDO.subscribe`/`unsubscribe` →
		// `TopicDO | Worker`. These are resolved on the DO side when alchemy invokes
		// the method (it provides the worker's captured services + global context).
		// At THIS (worker) call seam we discharge them cast-free with the worker's
		// own context, captured once in init: it already holds `Worker` (alchemy
		// provides it to this `.make()` body) and both DO namespace Tags (`yield*`-ed
		// above), so `Effect.provide(_, workerContext)` supplies the real services —
		// no `as`-cast (the old `rpc` helper is gone).
		const workerContext = yield* Effect.context<ConnectionDO | TopicDO | Cloudflare.Worker>();
		const liveLayer = Layer.mergeAll(
			Layer.succeed(LiveTopics)(
				LiveTopics.of({
					publish: (topicKey, message) =>
						Effect.asVoid(topics.getByName(`topic:${topicKey}`).publish(message)).pipe(
							Effect.provide(workerContext),
						),
				}),
			),
			Layer.succeed(LiveConnections)(
				LiveConnections.of({
					open: (connectionId, request) =>
						connections.getByName(`connection:${connectionId}`).fetch(request),
					subscribe: (connectionId, input) =>
						connections
							.getByName(`connection:${connectionId}`)
							.subscribe(input)
							.pipe(Effect.provide(workerContext)),
					unsubscribe: (connectionId, subId) =>
						connections
							.getByName(`connection:${connectionId}`)
							.unsubscribe({subId})
							.pipe(Effect.provide(workerContext)),
				}),
			),
		);

		// `AppLive` is the whole HTTP surface, Hono-free (ADR 0027):
		//   - typed JSON via `HttpApiBuilder` groups: `GET /api/health` + the
		//     dev-only `/api/admin/*` seeders (schema-decoded payloads),
		//   - raw `Request` via imperative `HttpRouter.add`: `POST /fate`,
		//     `* /fate/live` (SSE → ConnectionDO), `* /api/auth/*` (better-auth),
		//     `* /agents/*` (stub).
		// `makeAppLive` discharges the raw routes' worker-level requirements with
		// `HttpRouter.provideRequest(...)` and provides the admin services +
		// platform stubs to the typed groups (`http/app.ts`).
		const AppLive = makeAppLive({fateLayer, adminLayer, adminAllowed: allowAdmin, env, liveLayer});

		// ── RUNTIME PHASE (per request) ──
		return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		// One combined provide (chaining multiple `Effect.provide` can break layer
		// lifecycle). Three Layers:
		//   - `D1ConnectionLive` satisfies `D1Connection.bind`'s `R` requirement.
		//   - `ConnectionDOLive` / `TopicDOLive` are the two live-fan-out DOs in
		//     `.make()` form (ADR 0028): each registers its DO class with the
		//     worker's exports and resolves the `ConnectionDO`/`TopicDO` Tag the
		//     init phase yields. Each DO resolves its sibling per fan-out call
		//     (`yield* TopicDO` / `yield* ConnectionDO` inside an RPC method,
		//     `infra/*-do.ts`), so the Tag lands on the method's `R`, never on the
		//     Layer's init requirements — that keeps `ConnectionDOLive` ↔
		//     `TopicDOLive` free of a circular Layer dependency, so merging both
		//     satisfies each one's sibling Tag from the other (and from this host).
		Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive, ConnectionDOLive, TopicDOLive)),
	),
);
