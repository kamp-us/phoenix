/**
 * The single phoenix worker, on alchemy-effect (ADR 0026–0031).
 *
 * `export default class Phoenix extends Cloudflare.Worker<Phoenix>()(id, props, body)`.
 * The body runs in two phases: the init phase binds resources (D1 + the two
 * live-fan-out Durable Object namespaces) once per isolate; the runtime phase
 * returns the `fetch` handler — an `HttpRouter` compiled with
 * `HttpRouter.toHttpEffect`. The SPA is served from the `assets` prop, with
 * `runWorkerFirst` keeping the worker-owned paths (`/api/*`, `/fate`, `/fate/*`)
 * from being intercepted by the SPA shell.
 *
 * This replaces `wrangler.jsonc` (bindings/DOs/migrations/assets/vars) and the
 * Hono `export default {fetch}` entry. FOUNDATION SLICE (alchemy-migration task
 * 1): only `GET /api/health` is wired. The fate data plane, better-auth, the
 * admin seeders, and the live SSE route are ported onto this worker in tasks
 * 2–5 (the modules still live under `worker/fate/` and `worker/features/`).
 *
 * Dev vs prod for the SPA (ADR 0030): the `assets` + `runWorkerFirst` config
 * below is the *production* single-worker precedence — at the Cloudflare edge,
 * non-worker paths are answered by the asset server and the worker only sees the
 * `runWorkerFirst` globs. In the local dev loop `vite dev` serves the SPA (with
 * HMR) and proxies `/api` + `/fate*` to this worker (task 6); under bare
 * `alchemy dev` this worker is API-only, so a non-API path has no SPA to return.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {makeFateLayer} from "./fate/layers.ts";
import {fateRoute} from "./fate/route.ts";
import ConnectionDO from "./infra/connection-do.ts";
import {PhoenixDb} from "./infra/resources.ts";
import TopicDO from "./infra/topic-do.ts";
import {createDrizzle} from "./services/Drizzle.ts";

/**
 * The worker's bound resource handles, captured once in the init phase. The
 * D1 client (`db`) and the two DO namespaces are the typed clients `bind()` /
 * `yield*` resolve. Holding them in one typed record makes each binding
 * load-bearing — the field types are derived from the bind expressions, so
 * dropping a bind is a compile error here.
 */
interface WorkerResources {
	readonly db: Effect.Success<ReturnType<typeof Cloudflare.D1Connection.bind>>;
	readonly connections: Effect.Success<typeof ConnectionDO>;
	readonly topics: Effect.Success<typeof TopicDO>;
}

// `GET /api/health` — the liveness probe. Reads the worker's `ENVIRONMENT` var
// off `WorkerEnvironment` (the alchemy equivalent of the old `c.env.ENVIRONMENT`)
// and returns it as JSON. The single route wired in the foundation slice.
const health = HttpRouter.add(
	"GET",
	"/api/health",
	Effect.gen(function* () {
		const env = yield* Cloudflare.WorkerEnvironment;
		return yield* HttpServerResponse.json({
			status: "ok",
			environment: (env as Record<string, unknown>).ENVIRONMENT ?? null,
		});
	}),
);

export default class Phoenix extends Cloudflare.Worker<Phoenix>()(
	"phoenix",
	{
		main: import.meta.filename,
		env: {ENVIRONMENT: "development"},
		assets: {
			// The built SPA shell. `@cloudflare/vite-plugin` (still present until
			// task 6 removes it) nests the client build under `dist/client/client`;
			// task 6 flattens this back to `./dist/client` when the plugin is dropped.
			directory: "./dist/client/client",
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
	},
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

		// Hold the bound clients as the worker's typed resource handles. Capturing
		// them here keeps each binding load-bearing: drop a `bind()`/`yield*` above
		// and this record stops type-checking — an unwired binding is a compile
		// error, never a runtime `undefined` (acceptance criterion).
		const resources: WorkerResources = {db, connections, topics};
		void resources;

		// Build the worker-level fate layer ONCE from the bound D1 (ADR 0029):
		// `conn.raw` is the underlying Cloudflare `D1Database`, handed to
		// `drizzle(raw, {schema})`; `Drizzle` + the feature services are
		// constructed here and stay alive for the isolate. The `/fate` route
		// provides only `Auth`/`RequestContext` per request — there is no
		// per-request `ManagedRuntime`.
		const raw = yield* db.raw;
		const env = yield* Cloudflare.WorkerEnvironment;
		const fateLayer = makeFateLayer(createDrizzle(raw), env as unknown as Env);

		// The HTTP surface wired so far: `GET /api/health` (JSON liveness) and
		// `POST /fate` (the fate data plane). `fateRoute`'s handler requires the
		// worker-level feature services (`FateEnv` minus the per-request
		// `Auth`/`RequestContext` it provides itself); `HttpRouter.add` lifts those
		// into route-requirement markers (`Request.From<"Requires", …>`), which
		// `HttpRouter.provideRequest` — not plain `Layer.provide` — discharges from
		// `fateLayer` before `toHttpEffect`. Tasks 3–5 add the rest (auth, admin
		// seeders, live SSE).
		const AppLive = Layer.mergeAll(health, fateRoute.pipe(HttpRouter.provideRequest(fateLayer)));

		// ── RUNTIME PHASE (per request) ──
		return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		// `D1Connection.bind` requires its binding service in the `R` channel;
		// `D1ConnectionLive` satisfies it. Forgetting it is a type error.
		Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive)),
	),
) {}
