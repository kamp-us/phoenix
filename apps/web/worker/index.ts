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
import {makeAdminLayer, makeFateLayer} from "./fate/layers.ts";
import {LiveConnections, LiveTopics} from "./fate/live-topics.ts";
import {makeAppLive} from "./http/app.ts";
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

export default class Phoenix extends Cloudflare.Worker<Phoenix>()(
	"phoenix",
	{
		main: import.meta.filename,
		env: {
			ENVIRONMENT: "development",
			// Dev runs behind the Vite proxy, so the worker sees `Host:
			// 127.0.0.1:<port>` rather than the browser origin. better-auth needs
			// the real browser origin to set/validate its cookie, so we hand it the
			// origin explicitly (ADR 0031 / `auth.ts`) instead of inferring from the
			// inbound Host. No `https://` here — that would flip the cookie `Secure`
			// flag and break `http://localhost` storage.
			BETTER_AUTH_URL: "http://localhost:3000",
			BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:5173",
			// better-auth refuses to start on its built-in default secret. This is a
			// fixed *dev* value (not a real secret) so local sign-in/session works;
			// the production secret is wired at deploy (task 8) and must override it.
			BETTER_AUTH_SECRET: "phoenix-dev-secret-not-for-production",
		},
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
		const env = {
			...(yield* Cloudflare.WorkerEnvironment),
			PHOENIX_DB: raw,
		} as unknown as Env;
		const fateLayer = makeFateLayer(createDrizzle(raw), env);
		const adminLayer = makeAdminLayer(createDrizzle(raw));
		const adminAllowed = (env as unknown as Record<string, unknown>).ENVIRONMENT === "development";

		// The live path (ADR 0028/0029): both DO namespaces are resolved ONCE in
		// init (`topics`/`connections`, above) and wrapped as worker-level services.
		//   - `LiveTopics.publish` fans a mutation's `live.*` out via typed RPC
		//     (`topics.getByName(\`topic:${key}\`).publish(msg)`) — no `env` lookup,
		//     no `idFromName`, no string-URL `stub.fetch`.
		//   - `LiveConnections` opens the SSE stream (forwarding the request to a
		//     connection's `fetch`) and drives subscribe/unsubscribe RPC, addressing
		//     connections by name (`connection:${id}`).
		// The cross-DO fan-out itself (topic→connection deliver, connection→topic
		// register) is resolved LAZILY inside the DO RPC methods (`infra/*-do.ts`).
		//
		// The DO's lazy sibling resolution surfaces the alchemy `Worker` service in
		// each stub method's `R` (a typing artifact — alchemy captures and provides
		// the DO's own services when it invokes the method, so the caller never
		// supplies `Worker`). `rpc` discharges that artifact at the stub-call seam:
		// the call runs on the DO side, not here.
		const rpc = <A>(effect: Effect.Effect<A, never, Cloudflare.Worker>) =>
			effect as Effect.Effect<A, never, never>;

		const liveLayer = Layer.mergeAll(
			Layer.succeed(LiveTopics)(
				LiveTopics.of({
					publish: (topicKey, message) =>
						Effect.asVoid(rpc(topics.getByName(`topic:${topicKey}`).publish(message))),
				}),
			),
			Layer.succeed(LiveConnections)(
				LiveConnections.of({
					open: (connectionId, request) =>
						connections.getByName(`connection:${connectionId}`).fetch(request),
					subscribe: (connectionId, input) =>
						rpc(connections.getByName(`connection:${connectionId}`).subscribe(input)),
					unsubscribe: (connectionId, subId) =>
						rpc(connections.getByName(`connection:${connectionId}`).unsubscribe({subId})),
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
		const AppLive = makeAppLive({fateLayer, adminLayer, adminAllowed, liveLayer});

		// ── RUNTIME PHASE (per request) ──
		return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		// `D1Connection.bind` requires its binding service in the `R` channel;
		// `D1ConnectionLive` satisfies it. Forgetting it is a type error.
		Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive)),
	),
) {}
