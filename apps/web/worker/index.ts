/**
 * The single phoenix worker, on alchemy-effect (ADR 0026–0031).
 *
 * Modular `.make()` form (ADR 0028): the `Phoenix` class is the worker Tag
 * (declaring the hosted `LiveDO` as its `Deps`), `Phoenix.make(body)` is the
 * implementation Layer. Splitting them lets the worker host the DO and provide
 * its `.make()` Layer (the inline-body form can't take a `Deps` type param). The
 * body runs in two phases: init binds resources once per isolate; runtime returns
 * the `fetch` handler.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {RuntimeContext, Stage} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {ALCHEMY_PHASE} from "alchemy/Phase";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {AppConfig, envBindings} from "./config.ts";
import {Database, DatabaseLive} from "./db/Database.ts";
import {customHostname, resolveStateMode} from "./env.ts";
import {makeFateRuntime, PhoenixFateLive} from "./features/fate/layers.ts";
import {
	withColdStartRetry,
	withColdStartRetryFetch,
} from "./features/fate-live/cold-start-retry.ts";
import {connectionOf, LiveDO, LiveDOLive, topicOf} from "./features/fate-live/live-do.ts";
import type {DeliverFrame, PublishMessage} from "./features/fate-live/protocol.ts";
import {LiveConnections, LiveTopics} from "./features/fate-live/topics.ts";
import {Flagship, FlagshipLive} from "./features/flagship/Flagship.ts";
import {Flagship as FlagshipResource} from "./features/flagship/resources.ts";
import {BetterAuthLive} from "./features/pasaport/better-auth-live.ts";
import {EmailSenderLive} from "./features/pasaport/email-sender.ts";
import {makeAppLive} from "./http/app.ts";
import {workerFirstGlobs} from "./http/worker-routes.ts";

/**
 * Lift a publish-side `PublishMessage` to the `DeliverFrame` `LiveDO.publish`
 * enqueues. The frame's `id` (the fate subscription id) is left empty here — one
 * publish fans out to many subscriptions, each stamped with its own id by the
 * topic instance at delivery.
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
	// `{}` is alchemy's empty-RPC-shape sentinel (this worker exposes only
	// `fetch`); biome bans bare `{}`, but no other type expresses "no extra shape"
	// without forcing keys to `never`, which `{fetch}` then fails to satisfy.
	// biome-ignore lint/complexity/noBannedTypes: alchemy's empty-RPC-shape sentinel
	{},
	// The hosted live-fan-out DO, declared as the worker's `Deps` (ADR 0028) so it
	// can `yield*` the Tag in init and provide `.make()` below.
	LiveDO
>()(
	"phoenix",
	// Props are an Effect so `domain` can derive from the deploy's `Stage` (issue
	// #594). `Stage` is a deploy-only PlatformService — alchemy provides it solely in
	// the stack context (`Stack.make`), NEVER in workerd. But `Phoenix.make()` (the
	// runtime `PhoenixLive` Layer) re-runs this Effect on every isolate init to resolve
	// props (`Platform.make` → `SelfLayer`), so a `yield* Stage` here would die at
	// runtime and 500 every request. We gate the deploy-only derivation on
	// `ALCHEMY_PHASE === "plan"` (alchemy bakes `ALCHEMY_PHASE: "runtime"` into the
	// deployed worker; default is `"plan"`) — the same deploy-vs-runtime guard alchemy's
	// own `Binding.ts` uses. At runtime we return the plain props untouched, so the
	// fetch handler is identical to a domain-less worker; the Custom Domain (proxied DNS
	// + TLS on the `kamp.us` zone) is purely a deploy concern.
	Effect.gen(function* () {
		const props = {
			main: import.meta.filename,
			// Pin the local dev port. `alchemy dev` defaults to 1337 but can silently fall back
			// to the next free port; if a second app's worker ran alongside, that could make
			// the Vite proxy in `apps/web/vite.config.ts` point at the wrong worker.
			// `strictPort: true` makes collisions fail loudly instead of misrouting.
			dev: {port: 1337, strictPort: true},
			// Env bindings spread from `config.ts`'s `envBindings`, keyed by the
			// single-sourced binding names (`ENV_BINDINGS`): `ENVIRONMENT` → `plain_text`,
			// `BETTER_AUTH_SECRET` → `secret_text`. The names are NOT restated here — they
			// come from the same `as const` the `Config` constructors read under, so a
			// key↔name mismatch is unrepresentable (#1432). Alchemy resolves each at deploy
			// and runtime reads the same value off the auto-wired ConfigProvider.
			env: {
				...envBindings,
				// The Flagship app resource maps to the native `Flagship` runtime binding
				// via `InferEnv` (epic #488); the worker `bind()`s it in init below.
				FLAGS: FlagshipResource,
			},
			assets: {
				// The built SPA shell (`vite build` emits `dist/client`, ADR 0030; path is
				// relative to the alchemy CLI's `apps/web` cwd). At the edge the worker
				// serves it; the `runWorkerFirst` globs keep the worker-owned paths from
				// being shadowed by the SPA shell (a missing entry returns the shell for
				// GET and 405 for POST). Derived from the one worker-owned-route manifest
				// `app.ts` also consumes (`http/worker-routes.ts`), so route and glob can't
				// drift (#861).
				directory: "./dist/client",
				notFoundHandling: "single-page-application" as const,
				runWorkerFirst: [...workerFirstGlobs],
			},
			compatibility: {flags: ["nodejs_compat"]},
			// Workers Observability, declared explicitly rather than leaning on alchemy's
			// default-on (Worker.ts `observability ?? {enabled, logs:{enabled,invocationLogs}}`)
			// so the captured-exception behavior is legible in source. `headSamplingRate: 1`
			// keeps full capture at phoenix's current low volume. Source maps are uploaded
			// unconditionally by the bundler (`sourcemap: "hidden"` → `.map` parts), so worker
			// stack traces de-minify with no flag to set here. Field names are the alchemy/CF
			// camelCase (`WorkerObservability`), not wrangler snake_case.
			observability: {
				enabled: true,
				headSamplingRate: 1,
				logs: {enabled: true, invocationLogs: true},
			},
		};

		// The custom domain is deploy-time-only AND production-only: skip it at runtime
		// (where `Stage` is absent and a `yield* Stage` would 500 every request) and
		// offline (`alchemy dev` has no real CF zone — mirror the `resolveStateMode` gate
		// the state store uses). The `ALCHEMY_PHASE === "plan"` guard is the runtime-safety
		// gate (alchemy bakes `ALCHEMY_PHASE: "runtime"` into the deployed worker), and
		// `customHostname` is production-only: it yields `phoenix.kamp.us` for a prod deploy
		// and `undefined` for every non-prod stage. So an ephemeral integration `it-*`
		// `Test.make` stage attaches NO domain → its `worker.url` stays `*.workers.dev` →
		// the integration harness's `GET /api/health` hits a valid cert (a `<stage>` custom
		// domain's TLS cert isn't provisioned yet and broke every integration test, #983).
		const phase = yield* ALCHEMY_PHASE;
		if (phase !== "plan" || resolveStateMode(process.env) === "local") return props;

		const stage = yield* Stage;
		const domain = customHostname(stage, process.env.ENVIRONMENT ?? "");
		return domain === undefined ? props : {...props, domain};
	}),
) {}

export default Phoenix.make(
	Effect.gen(function* () {
		// ── INIT PHASE (deploy time + once per isolate) ──
		// Bind the resources: at deploy each call records binding metadata for the
		// Cloudflare API; at runtime it resolves the typed client, in scope for the
		// isolate's lifetime. `live` stays load-bearing through `liveLayer`'s
		// closures below — drop this `yield*` and the type checker fails there, so
		// an unwired binding is a compile error, never a runtime `undefined`.
		const live = yield* LiveDO;

		// Resolve the raw D1 handle from the `Database` seam ONCE in init (ADR
		// 0040) and wrap it dependency-free for the runtime build below, so the
		// routes never rebuild the seams per request (ADR 0041). `DatabaseLive`
		// (outer `Effect.provide`) resolves `PhoenixDb`; the shared handle feeds
		// both `DrizzleLive` and `BetterAuthLive`.
		const raw = yield* Database;
		const databaseLayer = Layer.succeed(Database)(raw);

		// Resolve the `BetterAuth` service ONCE in init (the cached
		// `makeBetterAuth(...)` instance from `BetterAuthLive`, provided below) so
		// `Pasaport.validateSession` and the `/api/auth/*` handler share one
		// instance — sign + validate with the same secret.
		const betterAuth = yield* BetterAuth.BetterAuth;
		const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)(betterAuth);

		// Resolve the Effect-native `FlagshipClient` ONCE in init (epic #488) via the
		// `Flagship` seam (`Cloudflare.FlagshipApp.bind(...)`, provided below) and wrap
		// it dependency-free for the routes — same shape as `Database` above.
		const flagshipClient = yield* Flagship;
		const flagshipLayer = Layer.succeed(Flagship)(flagshipClient);

		// The worker's ambient `RuntimeContext`, resolved once. The fate runtime needs
		// it because the pano draft-save gate (#746) reads `Flags` (a `RuntimeContext`
		// per-call requirement); `makeAppLive` reuses it for the `/api/auth/*` route.
		const runtimeContext = yield* RuntimeContext;

		// The deploy environment, resolved once in init (off the auto-wired
		// ConfigProvider). `makeAppLive` uses it for the load-bearing #622 gate:
		// install the dev-only flag-override wrapper ONLY under `development`. `orDie`:
		// a value outside the three literals is a malformed env, unrecoverable.
		const {environment: appEnvironment} = yield* AppConfig.pipe(Effect.orDie);

		// The one worker-level runtime (ADR 0041/0043 — init-only wiring): exactly
		// one per isolate from `PhoenixFateLive` (`R = Database | BetterAuth`, both
		// provided here). It is a layer-build vehicle only, no runtime on the
		// request path; the full story (shared memoMap, never-dispose deviation)
		// lives in `fate/layers.ts`. Its built context reaches the routes as
		// `fateLayer`.
		const {contextLayer: fateLayer} = makeFateRuntime(
			PhoenixFateLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						databaseLayer,
						betterAuthLayer,
						flagshipLayer,
						Layer.succeed(RuntimeContext)(runtimeContext),
					),
				),
			),
		);

		// NO init-time warmup (`yield*`-ing the runtime's `contextEffect`) —
		// deliberately. Workerd disallows async/timer work in init (global) scope,
		// so forcing the layer build here stalls the worker before it can serve.
		// The layer builds lazily on the first request instead. Config validation
		// does NOT wait for it: the same `collectConfigIssues` walk runs at BUILD
		// time inside `FateExecutor.toCodegenServer` (`schema.ts`), so `vite build`
		// fails on duplicate wire names / missing sources before the worker exists.

		// The live path (ADR 0028/0029): the unified `LiveDO` namespace resolved
		// once above, wrapped as worker-level services. One namespace plays both
		// roles, keyed by instance name. Addressing + name grammar live at the
		// `live-do.ts` seam. Cross-role fan-out rides the DO's OWN namespace
		// captured in its init closure, so every method's `R` is `never` — nothing
		// to discharge at this worker call seam.
		const liveLayer = Layer.mergeAll(
			Layer.succeed(LiveTopics)(
				LiveTopics.of({
					publish: (topicKey, message, limits) =>
						Effect.asVoid(
							topicOf(live, topicKey).publish({topicKey, frame: deliverFrameOf(message), limits}),
						),
				}),
			),
			Layer.succeed(LiveConnections)(
				LiveConnections.of({
					// A cold `connection:`/`topic:` DO's first RPC can fail on the alchemy
					// transport channel (`RpcCallError`); `withColdStartRetry` absorbs the
					// warm window and surfaces `LiveTransportError` on exhaustion (#842). The
					// SSE-open `.fetch` rejection arrives as a DEFECT, not an `RpcCallError`,
					// so it needs the `*Fetch` variant (#1048).
					open: (connectionId, request) =>
						withColdStartRetryFetch("open", connectionOf(live, connectionId).fetch(request)),
					subscribe: (connectionId, input) =>
						withColdStartRetry("subscribe", connectionOf(live, connectionId).subscribe(input)),
					unsubscribe: (connectionId, subId) =>
						withColdStartRetry(
							"unsubscribe",
							connectionOf(live, connectionId).unsubscribe({subId}),
						),
				}),
			),
		);

		// `AppLive` is the whole HTTP surface, Hono-free (ADR 0027). `makeAppLive`
		// discharges the raw routes' worker-level requirements via
		// `provideRequest` and wires the health group's platform stubs
		// (`http/app.ts`). Note this passes the INIT-RESOLVED `betterAuth` service,
		// not `BetterAuthLive` (why: `makeAppLive`'s `betterAuthLayer` doc).
		const AppLive = makeAppLive({
			fateLayer,
			liveLayer,
			betterAuthLayer,
			flagshipLayer,
			runtimeContext,
			environment: appEnvironment,
		});

		// ── RUNTIME PHASE (per request) ──
		return {fetch: AppLive.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		// One combined provide (chaining multiple `Effect.provide` can break layer
		// lifecycle). `LiveDOLive` registers the unified DO and resolves the
		// `LiveDO` Tag (no circular Layer dependency, unlike the old
		// `ConnectionDOLive` ↔ `TopicDOLive` pair it replaces). `BetterAuthLive`
		// satisfies the `BetterAuth` tag and derives its raw d1 from the `Database`
		// seam (ADR 0040), so `DatabaseLive` is provided into it.
		Effect.provide(
			Layer.mergeAll(
				LiveDOLive,
				// `provideMerge` keeps both `Database` (yielded in init) and
				// `BetterAuth` in scope while wiring the dependency in build order (a
				// flat `mergeAll` would run them in parallel and not wire it).
				// `EmailSenderLive` (ADR 0101) is provided into it too: the better-auth
				// email callbacks resolve `EmailSender`. The production adapter binds the
				// `send_email` descriptor through alchemy's `SendEmailBindingLive`
				// (`WorkerEnvironment`/`RuntimeContext` ambient), the same binding-graph
				// shape as Flagship below; dev/preview pick the log sink and never touch
				// the binding.
				BetterAuthLive.pipe(
					Layer.provideMerge(DatabaseLive),
					Layer.provide(
						EmailSenderLive.pipe(
							Layer.provide(Cloudflare.SendEmailBindingLive),
							Layer.provide(Cloudflare.SendEmailBindingPolicyLive),
						),
					),
				),
				// The `Flagship` seam (`bind()`-in-init) resolves through alchemy's
				// Flagship binding graph: `FlagshipBindingLive` turns the app resource
				// into the `FlagshipClient`, `FlagshipBindingPolicyLive` registers the
				// policy it needs (epic #488). `WorkerEnvironment` is ambient.
				FlagshipLive.pipe(
					Layer.provide(Cloudflare.FlagshipBindingLive),
					Layer.provide(Cloudflare.FlagshipBindingPolicyLive),
				),
			).pipe(Layer.provideMerge(Cloudflare.D1ConnectionLive)),
		),
	),
);
