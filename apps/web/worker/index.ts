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
import {wrapRequestHandler} from "@sentry/cloudflare";
import {RuntimeContext, Stage} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {ALCHEMY_PHASE} from "alchemy/Phase";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {AppConfig, ENV_BINDINGS, envBindings, sentryDsn} from "./config.ts";
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
import {subscribeHotScoreDecay} from "./features/pano/hot-score-decay-cron.ts";
import {BetterAuthLive} from "./features/pasaport/better-auth-live.ts";
import {EmailSenderLive} from "./features/pasaport/email-sender.ts";
import {Events as TelemetryEvents} from "./features/telemetry/resources.ts";
import {TelemetryClient} from "./features/telemetry/Telemetry.ts";
import {makeAppLive} from "./http/app.ts";
import {workerFirstGlobs} from "./http/worker-routes.ts";
import {workerOptions} from "./lib/sentry.ts";
import {captureUnhandled} from "./lib/sentry-capture.ts";
import {SentryEffectLive} from "./lib/sentry-effect.ts";

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
>()("phoenix") {}

// Props moved from the Worker constructor to `.make(props, impl)` in alchemy
// beta.59 (the tag carries name + RPC shape; props live on `.make`).
const phoenixProps =
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
		// Deploy-time-only DSN source (ADR 0118, #1502): read off `process.env` here in
		// the alchemy CLI process, NOT via a `Config` — the binding is what carries the
		// value to workerd. Absent-safe: unset ⇒ no `SENTRY_DSN` binding is added below,
		// so the runtime read (`sentryDsn`, config.ts) resolves `None` and the worker
		// Sentry path stays inert.
		const sentryDsnValue = process.env[ENV_BINDINGS.sentryDsn];

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
				// via `InferEnv` (epic #488); the worker `bind()`s it in init below. The
				// env key matches the `Flagship` Tag/consumer so the name is one across
				// declare → bind → consume (#1439); runtime resolution is by the app's
				// `LogicalId` (`phoenix_flags`), not this key, so the rename is behavior-neutral.
				Flagship: FlagshipResource,
				// The Analytics Engine `app_events` dataset (ADR 0153, epic #2065): bound as
				// the `Events` runtime binding so worker init can resolve the write client via
				// `Cloudflare.AnalyticsEngine.WriteDataset(Events)`. No provisioning — an AE
				// dataset is created on first `writeDataPoint`. The `Telemetry` service that
				// consumes the client lands in #2067; this child wires the binding only.
				Events: TelemetryEvents,
				// Optional Sentry DSN (ADR 0118, #1502): bound `secret_text` (a redacted
				// value) ONLY when a DSN is present in the deploy env, so an unset DSN adds
				// no binding at all. Single-sourced name via `ENV_BINDINGS.sentryDsn` (#1432).
				...(sentryDsnValue ? {[ENV_BINDINGS.sentryDsn]: Redacted.make(sentryDsnValue)} : {}),
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
	});

export default Phoenix.make(
	phoenixProps,
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
		// `Flagship` seam (`Cloudflare.Flagship.ReadFlags(...)`, provided below) and wrap
		// it dependency-free for the routes — same shape as `Database` above.
		const flagshipClient = yield* Flagship;
		const flagshipLayer = Layer.succeed(Flagship)(flagshipClient);

		// Resolve the Analytics Engine write client ONCE in init (ADR 0153, #2067) —
		// where the `WriteDataset` binding graph is ambient (provided below) — and
		// wrap it dependency-free on the `TelemetryClient` seam for the fate runtime,
		// same shape as `Flagship`/`Database` above. Keeping the binding resolution
		// here (not in `TelemetryLive`) keeps the fate runtime's R free of
		// `WorkerEnvironment`/`Worker`.
		const telemetryClient = yield* Cloudflare.AnalyticsEngine.WriteDataset(TelemetryEvents);
		const telemetryLayer = Layer.succeed(TelemetryClient)(telemetryClient);

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
						// The init-resolved AE write client (ADR 0153, #2067) the `Telemetry`
						// seam emits through; `RuntimeContext` (below) discharges the ambient
						// requirement `writeDataPoint` needs, captured once in `TelemetryLive`.
						telemetryLayer,
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

		// The sıcak/hot decay-refresh Cron Trigger (#2027): register the `scheduled`
		// listener (runtime) + attach the cron expression to the worker (deploy). The
		// handler re-decays `post_record.hot_score` over the recency window so the hot
		// feed keeps decaying with age without an activity write, preserving the
		// stored-column + keyset-cursor design (no read-time recompute). Provided the
		// built `fateLayer` so it resolves `Pano` at dispatch. `subscribe` only
		// registers a listener (no async/timer work), so it is init-safe.
		yield* subscribeHotScoreDecay(fateLayer);

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
							topicOf(live, topicKey)
								.publish({topicKey, frame: deliverFrameOf(message), limits})
								.pipe(Effect.provideService(RuntimeContext, runtimeContext)),
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
						withColdStartRetry(
							"subscribe",
							connectionOf(live, connectionId)
								.subscribe(input)
								.pipe(Effect.provideService(RuntimeContext, runtimeContext)),
						),
					unsubscribe: (connectionId, subId) =>
						withColdStartRetry(
							"unsubscribe",
							connectionOf(live, connectionId)
								.unsubscribe({subId})
								.pipe(Effect.provideService(RuntimeContext, runtimeContext)),
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

		// The optional Sentry DSN, read once in init off the auto-wired ConfigProvider.
		// `None` when no `SENTRY_DSN` binding was added at deploy (config.ts) — the gate
		// that keeps the worker Sentry path structurally inert.
		const dsn = yield* sentryDsn;

		// ── RUNTIME PHASE (per request) ──
		// `AppLive.pipe(toHttpEffect)` is an `Effect` yielding the request `HttpEffect`;
		// alchemy owns the raw request→Response conversion (ADR 0027). There is no
		// `ExportedHandler` to hand `@sentry/cloudflare` the standard `withSentry`
		// recipe, so error capture is wired at THIS Effect boundary instead (ADR 0118,
		// #1502): when a DSN is present, wrap the request `HttpEffect` in
		// `wrapRequestHandler` (real client init + isolate-safe transport + flush bound
		// to `ctx.waitUntil`). `Cloudflare.makeRequestEffect` reuses alchemy's OWN
		// `HttpServerResponse`→web conversion (incl. the SSE scope transfer) so the
		// wrapped handler returns a web `Response`; `HttpServerResponse.fromWeb` hands it
		// back for alchemy's outer conversion. No DSN ⇒ the base effect is returned
		// verbatim, so nothing here runs (mirrors the SPA `sentryEnabled` gate).
		//
		// `SentryEffectLive` (the Sentry Tracer/Logger, ADR 0029/0118) is merged into the
		// router layer here for tracing spans + `Effect.log*` breadcrumbs; it's baked into
		// the built `httpEffect`, so it survives the re-run inside `wrapRequestHandler`.
		// Merged unconditionally — inert without a bound client (`sentry-effect.ts`). It
		// does NOT create issues from unhandled failures (it never calls `captureException`);
		// that is `captureUnhandled`'s job at the seam below (`sentry-capture.ts`).
		const baseFetch = AppLive.pipe(Layer.provide(SentryEffectLive), HttpRouter.toHttpEffect);
		const fetch = Option.match(dsn, {
			onNone: () => baseFetch,
			onSome: (value) =>
				Effect.map(baseFetch, (httpEffect) =>
					Effect.gen(function* () {
						const request = yield* Cloudflare.Request;
						const context = yield* Cloudflare.WorkerExecutionContext;
						// Capture the request-scoped services (HttpServerRequest, Scope, the
						// route markers) so the inner run inside `wrapRequestHandler`'s Promise
						// thunk keeps them — a bare `Effect.runPromise` would start on the empty
						// default context and lose them.
						const requestContext = yield* Effect.context<Effect.Services<typeof httpEffect>>();
						// alchemy types `makeRequestEffect` as `=> any` and pins its handler to the
						// `HttpEffect<Req>` alias, narrower than `toHttpEffect`'s inferred result;
						// assert its real contract so its OWN `HttpServerResponse`→web conversion
						// (with the SSE scope transfer) is reused typed rather than re-forked.
						const toWebResponse = Cloudflare.makeRequestEffect as (
							webRequest: globalThis.Request,
							handler: typeof httpEffect,
						) => Effect.Effect<Response, never, Effect.Services<typeof httpEffect>>;
						// `captureUnhandled` catches the router handler's `Cause` and turns a
						// 5xx-class failure/defect into a Sentry issue (ADR 0118, #1502) — the
						// swallow inside alchemy's `Http.safeHttpEffect` is why `captureErrors`
						// alone never fires. It runs inside this `runPromise` (thus inside
						// `wrapRequestHandler`'s client scope), captures + flushes inline, and
						// returns the response as a success value. `captureErrors: true` stays a
						// backstop for anything that still rejects the thunk. Full rationale + the
						// flush-on-die finding live in `sentry-capture.ts`.
						const captured = captureUnhandled(httpEffect);
						const webResponse = yield* Effect.promise(() =>
							wrapRequestHandler(
								{options: workerOptions(value), request, context, captureErrors: true},
								() =>
									Effect.runPromise(
										toWebResponse(request, captured).pipe(Effect.provide(requestContext)),
									),
							),
						);
						return HttpServerResponse.fromWeb(webResponse);
					}),
				),
		});
		return {fetch};
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
					Layer.provide(EmailSenderLive.pipe(Layer.provide(Cloudflare.Email.SendBinding))),
				),
				// The `Flagship` seam (`bind()`-in-init) resolves through alchemy's
				// Flagship binding graph: `FlagshipBindingLive` turns the app resource
				// into the `FlagshipClient`, `FlagshipBindingPolicyLive` registers the
				// policy it needs (epic #488). `WorkerEnvironment` is ambient.
				FlagshipLive.pipe(Layer.provide(Cloudflare.Flagship.ReadFlagsBinding)),
				// The AE `WriteDataset` binding graph (ADR 0153, #2067): resolves the
				// `WriteDataset` tag `yield* Cloudflare.AnalyticsEngine.WriteDataset(Events)`
				// reads in init to get the write client. `WorkerEnvironment` is ambient at
				// the worker scope, the same binding-graph shape as Flagship's `ReadFlagsBinding`.
				Cloudflare.AnalyticsEngine.WriteDatasetBinding,
				// The Cron Trigger runtime seam the sıcak/hot decay-refresh subscribes to
				// (#2027): `subscribeHotScoreDecay` above `yield*`s `Cloudflare.cron(...).subscribe`,
				// which resolves this `CronEventSource`. Its deploy-time policy
				// (`CronEventSourcePolicy`) rides `Cloudflare.providers()`; `RuntimeContext` is
				// ambient at the worker scope.
				Cloudflare.CronEventSourceLive,
			).pipe(Layer.provideMerge(Cloudflare.D1.QueryDatabaseBinding)),
		),
	),
);
