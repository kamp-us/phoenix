/**
 * The single phoenix worker, on alchemy-effect (ADR 0026–0031).
 *
 * Modular `.make()` form (ADR 0028): `class Phoenix extends Cloudflare.Worker<
 * Phoenix, {}, LiveDO>()(id, props)` is the worker Tag (declaring the single
 * hosted live-fan-out DO as its `Deps` contract), and the `export default
 * Phoenix.make(body)` Layer is the implementation. Splitting the two lets the
 * worker host the DO and provide its `.make()` Layer (the inline-body form can't
 * take a `Deps` type param). The body runs in two phases: the init phase binds
 * resources (D1 + the `LiveDO` namespace) once per isolate; the runtime phase
 * returns the `fetch` handler — an `HttpRouter` compiled with
 * `HttpRouter.toHttpEffect`. The SPA is served from the `assets` prop, with
 * `runWorkerFirst` keeping the worker-owned paths (`/api/*`, `/fate`, `/fate/*`)
 * from being intercepted by the SPA shell.
 *
 * This replaces `wrangler.jsonc` (bindings/DOs/migrations/assets/vars) and the
 * Hono `export default {fetch}` entry. The full HTTP surface is wired here via
 * `makeAppLive` (`http/app.ts`): `GET /api/health`, the fate data plane
 * (`POST /fate`), better-auth (`* /api/auth/*`), and the live SSE route
 * (`* /fate/live` → LiveDO). The feature services live under
 * `worker/features/` (including the fate bridge under `worker/features/fate/`).
 *
 * Dev vs prod for the SPA (ADR 0030): the `assets` + `runWorkerFirst` config
 * below is the *production* single-worker precedence — at the Cloudflare edge,
 * non-worker paths are answered by the asset server and the worker only sees the
 * `runWorkerFirst` globs. In the local dev loop `vite dev` serves the SPA (with
 * HMR) and proxies `/api` + `/fate*` to this worker (task 6); under bare
 * `alchemy dev` this worker is API-only, so a non-API path has no SPA to return.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {betterAuthSecret, environment} from "./config.ts";
import {Database, DatabaseLive} from "./db/Database.ts";
import {makeFateLayer} from "./features/fate/layers.ts";
import {LiveDO, LiveDOLive} from "./features/fate-live/live-do.ts";
import type {DeliverFrame, PublishMessage} from "./features/fate-live/protocol.ts";
import {LiveConnections, LiveTopics} from "./features/fate-live/topics.ts";
import {BetterAuthLive} from "./features/pasaport/better-auth-live.ts";
import {makeAppLive} from "./http/app.ts";

/**
 * Lift a publish-side {@link PublishMessage} to the {@link DeliverFrame} the
 * unified `LiveDO.publish` enqueues. `kind` maps to the fate SSE event name
 * (`entity → next`, `connection → connection`); `event` is the already
 * inline-resolved frame body the mutation produced. The frame's `id` (the fate
 * subscription id) is set per-subscriber by the topic instance from each
 * subscriber row at delivery, so it is left empty here — one publish fans out to
 * many subscriptions, each with its own id.
 */
function deliverFrameOf(message: PublishMessage): DeliverFrame {
	return {
		kind: message.kind === "entity" ? "next" : "connection",
		id: "",
		event: message.frame,
		...(message.eventId !== undefined ? {eventId: message.eventId} : {}),
	};
}

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
	// The unified live-fan-out DO this worker hosts — declared as its public
	// `Deps` contract (ADR 0028) so the worker can `yield*` its Tag in init and
	// provide its `.make()` Layer below. One `LiveDO` namespace plays both the
	// connection and topic roles, keyed by instance name (`connection:`/`topic:`).
	LiveDO
>()("phoenix", {
	main: import.meta.filename,
	// The worker's env bindings, per-key from the `effect/Config` constants in
	// `worker/config.ts`. Alchemy resolves each Config at deploy from the
	// deploy-time `process.env` and binds it; runtime code reads the same value
	// off the ConfigProvider alchemy auto-wires from this env.
	//   - `ENVIRONMENT` — non-redacted Config → `plain_text` binding (fail-closed
	//     to "production"). Read via `yield* AppConfig` (BetterAuthLive's dev auth
	//     URLs + magic-link gate, the health probe).
	//   - `BETTER_AUTH_SECRET` — `Config.redacted` → `secret_text` binding (a
	//     Cloudflare secret). Read via `yield* betterAuthSecret` in BetterAuthLive
	//     to sign sessions. Required at deploy (the `dev:worker` script supplies a
	//     dev value; CI/prod supply the real one) — a missing secret fails closed.
	env: {ENVIRONMENT: environment, BETTER_AUTH_SECRET: betterAuthSecret},
	assets: {
		// The built SPA shell. `vite build` (no `@cloudflare/vite-plugin`,
		// ADR 0030) emits the client directly into `dist/client`; the path is
		// relative to the alchemy CLI's working dir (`apps/web`). At the
		// Cloudflare edge the worker serves this via `assets` + `runWorkerFirst`
		// (below) with no proxy; the dev proxy in `vite.config.ts` exists only
		// for the two-process dev loop.
		directory: "./dist/client",
		// The SPA shell answers any non-worker path; the worker-owned paths
		// are listed in `runWorkerFirst` so the asset server doesn't shadow
		// them (a missing entry returns the shell for GET and 405 for POST).
		// beta.52 flattened the asset config onto `AssetsProps` (no `config`
		// wrapper): `notFoundHandling` / `runWorkerFirst` sit beside `directory`.
		notFoundHandling: "single-page-application",
		runWorkerFirst: ["/api/*", "/fate", "/fate/*"],
	},
	compatibility: {flags: ["nodejs_compat"]},
	observability: {enabled: true},
}) {}

/**
 * The worker implementation Layer (modular `.make()` form, ADR 0028). Splitting
 * the class (a lightweight identity, with the hosted live-fan-out DO declared in
 * its `Deps` type param) from `.make()` lets the worker host `LiveDO` and provide
 * its `.make()` Layer without the inline-body form's `InitReq extends
 * WorkerServices | PlatformServices` constraint — the `LiveDO` Tag `yield*`-ed in
 * init is dischargeable here.
 */
export default Phoenix.make(
	Effect.gen(function* () {
		// ── INIT PHASE (deploy time + once per isolate) ──
		// Bind the resources. At deploy time each call records the binding's
		// metadata for the Cloudflare API; at runtime it resolves the typed client.
		// Everything bound here is in scope for the worker's whole lifetime.
		const live = yield* LiveDO;

		// `live` stays load-bearing through the `liveLayer` closures' `getByName(...)`
		// calls below — drop the `yield*` above and the type checker fails at that
		// usage, so an unwired binding is a compile error, never a runtime
		// `undefined`. The raw D1 is no longer bound here: it lives behind the
		// `Database` seam (ADR 0040), provided as `DatabaseLive` in the
		// outer `Effect.provide`, and both `DrizzleLive` and `BetterAuthLive` derive
		// from it — one shared handle, type-enforced.

		// Resolve the raw D1 handle from the `Database` seam ONCE in init (ADR
		// 0040). `DatabaseLive` (provided in the outer `Effect.provide`)
		// resolves the `PhoenixDb` binding; wrapping the resolved handle in a
		// `Layer.succeed(Database)` gives `makeAppLive` a stable, dependency-free
		// `databaseLayer` whose value `DrizzleLive` and `BetterAuthLive` both derive
		// from — one shared handle, type-enforced.
		const raw = yield* Database;
		const databaseLayer = Layer.succeed(Database)(raw);

		// The worker-level service layer (ADR 0029, ADR 0040): `makeFateLayer` is
		// a zero-arg constant whose `R` is `Database | BetterAuth`. Both seams are
		// discharged inside `makeAppLive`'s request layer (`databaseLayer` +
		// `betterAuthLayer` below). The `/fate` route provides only `Auth` per
		// request (ADR 0029).
		const fateLayer = makeFateLayer;

		// Resolve the `BetterAuth` Context tag (`@alchemy.run/better-auth`) here in
		// init — the layer (`BetterAuthLive`, provided below) constructs the
		// `makeBetterAuth(...)` instance once and caches it. Yielding it here
		// materializes the cached service, so `Pasaport.validateSession` (which runs
		// `auth.api.getSession(...)` per request) and the `/api/auth/*` route (which
		// runs `auth.handler(request)`) share one instance — sign + validate with
		// the same secret.
		const betterAuth = yield* BetterAuth.BetterAuth;

		// The live path (ADR 0028/0029): the unified `LiveDO` namespace is resolved
		// ONCE in init (`live`, above) and wrapped as worker-level services. One
		// namespace plays both roles, keyed by instance name.
		//   - `LiveTopics.publish` fans a mutation's `live.*` out via typed RPC
		//     (`live.getByName(\`topic:${key}\`).publish({topicKey, frame, limits})`)
		//     — no `env` lookup, no `idFromName`, no string-URL `stub.fetch`. The
		//     route builds the per-request `LiveLimits` and the publish frame is
		//     lifted from the `PublishMessage` by `deliverFrameOf`.
		//   - `LiveConnections` opens the SSE stream (forwarding the request to a
		//     connection-role `fetch`) and drives subscribe/unsubscribe RPC,
		//     addressing connections by name (`connection:${id}`). The route resolves
		//     a subscribe's topic keys + limits before calling.
		// The cross-role fan-out (topic→connection deliver, connection→topic
		// register) rides the DO's OWN namespace captured in its init closure
		// (`live-do.ts`), so the RPC methods' `R` is `never` — no per-call sibling
		// Tag. At THIS (worker) call seam there is nothing to discharge: every
		// method already has `R = never`, so no `Effect.provide(workerContext)` cast
		// is needed (the old split-DO sibling cast is gone).
		const liveLayer = Layer.mergeAll(
			Layer.succeed(LiveTopics)(
				LiveTopics.of({
					publish: (topicKey, message, limits) =>
						Effect.asVoid(
							live
								.getByName(`topic:${topicKey}`)
								.publish({topicKey, frame: deliverFrameOf(message), limits}),
						),
				}),
			),
			Layer.succeed(LiveConnections)(
				LiveConnections.of({
					open: (connectionId, request) =>
						live.getByName(`connection:${connectionId}`).fetch(request),
					subscribe: (connectionId, input) =>
						live.getByName(`connection:${connectionId}`).subscribe(input),
					unsubscribe: (connectionId, subId) =>
						live.getByName(`connection:${connectionId}`).unsubscribe({subId}),
				}),
			),
		);

		// Capture the worker's ambient `RuntimeContext` (the alchemy runtime-env
		// service this isolate runs inside). better-auth's `fetch`/`auth` carry an
		// undischarged `RuntimeContext` in their `R` (the reference type is
		// `HttpEffect<RuntimeContext>`), lifted into the `/api/auth/*` route's
		// per-request requirements by `HttpRouter.add`. `serve` passes `Req`
		// through rather than auto-providing it, so the worker discharges it for
		// its own request handler — `makeAppLive` feeds it into `provideRequest`.
		const runtimeContext = yield* RuntimeContext;

		// `AppLive` is the whole HTTP surface, Hono-free (ADR 0027):
		//   - typed JSON via an `HttpApiBuilder` group: `GET /api/health`,
		//   - raw `Request` via imperative `HttpRouter.add`: `POST /fate`,
		//     `* /fate/live` (SSE → LiveDO), `* /api/auth/*` (better-auth).
		// `makeAppLive` discharges the raw routes' worker-level requirements with
		// `HttpRouter.provideRequest(...)` and wires the health group's platform
		// stubs (`http/app.ts`).
		// Provide the INIT-RESOLVED `betterAuth` service to the routes — NOT
		// `BetterAuthLive`. `provideRequest` builds its layer per request, so
		// passing the layer would reconstruct better-auth (re-running the
		// `Random`/`Output` secret resolution, which needs `RuntimeContext` and the
		// deploy-time alchemy machinery absent in the workerd runtime) on every
		// request. The service resolved here in init carries the already-warmed
		// `auth` cache, so the `/api/auth/*` route's `betterAuth.fetch` reuses it
		// with no per-request reconstruction.
		const AppLive = makeAppLive({
			fateLayer,
			databaseLayer,
			liveLayer,
			betterAuthLayer: Layer.succeed(BetterAuth.BetterAuth)(betterAuth),
			runtimeContext,
		});

		// ── RUNTIME PHASE (per request) ──
		return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		// One combined provide (chaining multiple `Effect.provide` can break layer
		// lifecycle). The Layers:
		//   - `D1ConnectionLive` satisfies `D1Connection.bind`'s `R` requirement —
		//     `DatabaseLive` (provided into `BetterAuthLive` below) binds `PhoenixDb`
		//     through it.
		//   - `LiveDOLive` is the unified live-fan-out DO in `.make()` form
		//     (ADR 0028): it registers the single DO class with the worker's exports
		//     and resolves the `LiveDO` Tag the init phase yields. Cross-role calls
		//     ride the DO's OWN namespace captured in its init closure (not a sibling
		//     Tag), so the Layer requires only `Worker` — there is no circular Layer
		//     dependency to break, unlike the old `ConnectionDOLive` ↔ `TopicDOLive`
		//     pair this replaces.
		//   - `BetterAuthLive` (`features/pasaport/better-auth-live.ts`) satisfies the
		//     `BetterAuth` Context tag yielded above + provides `betterAuth.fetch` to
		//     the `/api/auth/*` route. It derives its raw d1 from the `Database` seam
		//     (ADR 0040), so `DatabaseLive` is provided into it here.
		Effect.provide(
			Layer.mergeAll(
				LiveDOLive,
				// `DatabaseLive` resolves `PhoenixDb`; `BetterAuthLive` derives its raw
				// d1 from it. `provideMerge` keeps both `Database` (yielded in init) and
				// `BetterAuth` in scope while satisfying the dependency in build order
				// (a flat `mergeAll` would run them in parallel and not wire it).
				BetterAuthLive.pipe(Layer.provideMerge(DatabaseLive)),
			).pipe(Layer.provideMerge(Cloudflare.D1ConnectionLive)),
		),
	),
);
