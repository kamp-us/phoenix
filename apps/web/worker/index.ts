/**
 * The single phoenix worker, on alchemy-effect (ADR 0026–0031, see also
 * .patterns/alchemy-worker.md). The body runs in two phases: init binds resources
 * once per isolate; runtime returns the `fetch` handler.
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
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {ENV_BINDINGS, envBindings, sentryDsn} from "./config.ts";
import {Database, DatabaseLive} from "./db/Database.ts";
import {DrizzleLive} from "./db/Drizzle.ts";
import {customHostname, resolveStateMode} from "./env.ts";
import {makeFateRuntime, PhoenixFateLive} from "./features/fate/layers.ts";
import {
	withColdStartRetry,
	withColdStartRetryFetch,
} from "./features/fate-live/cold-start-retry.ts";
import {connectionOf, LiveDO, LiveDOLive, topicOf} from "./features/fate-live/live-do.ts";
import {deliverFrameOf} from "./features/fate-live/protocol.ts";
import {LiveConnections, LiveTopics} from "./features/fate-live/topics.ts";
import {Flagship, FlagshipLive} from "./features/flagship/Flagship.ts";
import {Flagship as FlagshipResource} from "./features/flagship/resources.ts";
import {subscribeHotScoreDecay} from "./features/pano/hot-score-decay-cron.ts";
import {BetterAuthLive} from "./features/pasaport/better-auth-live.ts";
import {EmailDeliveryLogLive} from "./features/pasaport/email-delivery-log.ts";
import {EmailSenderLive} from "./features/pasaport/email-sender.ts";
import {subscribeSozlukReconcile} from "./features/sozluk/sozluk-reconcile-cron.ts";
import {Events as TelemetryEvents} from "./features/telemetry/resources.ts";
import {TelemetryClient} from "./features/telemetry/Telemetry.ts";
import {makeAppLive} from "./http/app.ts";
import {workerFirstGlobs} from "./http/worker-routes.ts";
import {workerOptions} from "./lib/sentry.ts";
import {captureUnhandled} from "./lib/sentry-capture.ts";
import {SentryEffectLive} from "./lib/sentry-effect.ts";

class RequestHandlerError extends Schema.TaggedErrorClass<RequestHandlerError>()(
	"web/RequestHandlerError",
	{cause: Schema.Defect()},
) {}

export class Phoenix extends Cloudflare.Worker<
	Phoenix,
	// No other type expresses "no extra shape" without forcing keys to `never`,
	// which `{fetch}` then fails to satisfy.
	// biome-ignore lint/complexity/noBannedTypes: alchemy's empty-RPC-shape sentinel
	{},
	// The hosted live-fan-out DO, declared as the worker's `Deps` (ADR 0028).
	LiveDO
>()("phoenix") {}

const phoenixProps =
	// This props Effect re-runs on every isolate init, so every deploy-only
	// derivation below is gated on `ALCHEMY_PHASE === "plan"` — a bare `yield* Stage`
	// here 500s every live request. See .patterns/cloudflare-deploy-time-iac.md.
	Effect.gen(function* () {
		// Deploy-time-only DSN source (ADR 0118): read off `process.env` in the alchemy
		// CLI process, NOT via a `Config` — the binding carries the value to workerd.
		// Unset ⇒ no binding below ⇒ the runtime read resolves `None` and Sentry is inert.
		const sentryDsnValue = process.env[ENV_BINDINGS.sentryDsn];

		const props = {
			main: import.meta.filename,
			// `strictPort` makes a port collision fail loudly; `alchemy dev` otherwise falls
			// back to the next free port and the Vite proxy silently hits the wrong worker.
			dev: {port: 1337, strictPort: true},
			// Binding names are NOT restated here — they come from the same `as const` the
			// `Config` constructors read under, so a key↔name mismatch is unrepresentable (#1432).
			env: {
				...envBindings,
				// Runtime resolution is by the app's `LogicalId` (`phoenix_flags`), not this key.
				Flagship: FlagshipResource,
				// No provisioning — an AE dataset is created on first `writeDataPoint` (ADR 0153).
				Events: TelemetryEvents,
				...(sentryDsnValue ? {[ENV_BINDINGS.sentryDsn]: Redacted.make(sentryDsnValue)} : {}),
			},
			assets: {
				// The `runWorkerFirst` globs keep worker-owned paths from being shadowed by
				// the SPA shell (a missing entry returns the shell for GET, 405 for POST).
				// Derived from the one manifest `app.ts` also consumes, so they can't drift (#861).
				directory: "./dist/client",
				notFoundHandling: "single-page-application" as const,
				runWorkerFirst: [...workerFirstGlobs],
			},
			compatibility: {flags: ["nodejs_compat"]},
			// See ADR 0168, amended by ADR 0179.
			placement: {mode: "smart" as const},
			// Field names are the alchemy/CF camelCase (`WorkerObservability`), not
			// wrangler snake_case.
			observability: {
				enabled: true,
				headSamplingRate: 1,
				logs: {enabled: true, invocationLogs: true},
			},
			// Inert on its own — Workers Caching caches a GET/HEAD response ONLY when the
			// worker stamps `Cache-Control` (ADR 0170).
			cache: {enabled: true},
		};

		// Deploy-time-only AND production-only. A non-prod stage must attach NO domain:
		// a `<stage>` custom domain's TLS cert isn't provisioned yet, and the integration
		// harness's `GET /api/health` needs a valid cert (#983).
		const phase = yield* ALCHEMY_PHASE;
		if (phase !== "plan" || resolveStateMode(process.env) === "local") return props;

		const stage = yield* Stage;
		const domain = customHostname(stage, process.env.ENVIRONMENT ?? "");
		return domain === undefined ? props : {...props, domain};
	});

export default Phoenix.make(
	phoenixProps,
	Effect.gen(function* () {
		const live = yield* LiveDO;

		// Resolve the raw D1 handle ONCE in init and wrap it dependency-free, so the
		// routes never rebuild the seams per request (ADRs 0040/0041).
		const raw = yield* Database;
		const databaseLayer = Layer.succeed(Database)(raw);

		// One instance, so `Pasaport.validateSession` and the `/api/auth/*` handler
		// sign + validate with the same secret.
		const betterAuth = yield* BetterAuth.BetterAuth;
		const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)(betterAuth);

		const flagshipClient = yield* Flagship;
		const flagshipLayer = Layer.succeed(Flagship)(flagshipClient);

		// Resolving the binding here rather than in `TelemetryLive` keeps the fate
		// runtime's R free of `WorkerEnvironment`/`Worker` (ADR 0153).
		const telemetryClient = yield* Cloudflare.AnalyticsEngine.WriteDataset(TelemetryEvents);
		const telemetryLayer = Layer.succeed(TelemetryClient)(telemetryClient);

		const runtimeContext = yield* RuntimeContext;

		// One worker-level runtime per isolate (ADRs 0041/0043 — init-only wiring). It
		// is a layer-build vehicle only, never on the request path; the shared memoMap
		// and never-dispose deviation live in `fate/layers.ts`.
		const {contextLayer: fateLayer} = makeFateRuntime(
			PhoenixFateLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						databaseLayer,
						betterAuthLayer,
						flagshipLayer,
						telemetryLayer,
						Layer.succeed(RuntimeContext)(runtimeContext),
					),
				),
			),
		);

		// NO init-time warmup (`yield*`-ing the runtime's `contextEffect`) —
		// deliberately. Workerd disallows async/timer work in init (global) scope, so
		// forcing the layer build here stalls the worker before it can serve. It builds
		// lazily on the first request; the same `collectConfigIssues` walk runs at BUILD
		// time in `FateExecutor.toCodegenServer`, so config errors still fail `vite build`.

		// `subscribe` only registers a listener (no async/timer work), so it is init-safe.
		yield* subscribeHotScoreDecay(fateLayer);
		yield* subscribeSozlukReconcile(fateLayer);

		// One `LiveDO` namespace plays both roles, keyed by instance name (ADRs 0028/0029);
		// addressing + name grammar live at the `live-do.ts` seam.
		const liveLayer = Layer.mergeAll(
			Layer.succeed(LiveTopics)(
				LiveTopics.of({
					// Bare, a publish to an idle-evicted `topic:` DO dropped its invalidation
					// silently (#2551). See ADR 0095.
					publish: (topicKey, message, limits) =>
						Effect.asVoid(
							withColdStartRetry(
								"publish",
								topicOf(live, topicKey)
									.publish({topicKey, frame: deliverFrameOf(message), limits})
									.pipe(Effect.provideService(RuntimeContext, runtimeContext)),
							),
						),
				}),
			),
			Layer.succeed(LiveConnections)(
				LiveConnections.of({
					// See ADR 0095. The SSE-open `.fetch` rejection arrives as a DEFECT, not an
					// `RpcCallError`, so it needs the `*Fetch` variant (#1048).
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

		// Passes the INIT-RESOLVED `betterAuth` service, not `BetterAuthLive` (why:
		// `makeAppLive`'s `betterAuthLayer` doc).
		const AppLive = makeAppLive({
			fateLayer,
			liveLayer,
			betterAuthLayer,
			flagshipLayer,
			runtimeContext,
		});

		// `None` when no `SENTRY_DSN` binding was added at deploy — the gate that keeps
		// the worker Sentry path structurally inert.
		const dsn = yield* sentryDsn;

		// There is no `ExportedHandler` to hand `@sentry/cloudflare` the standard
		// `withSentry` recipe, so error capture is wired at THIS Effect boundary instead
		// (ADR 0118). `SentryEffectLive` is merged unconditionally — inert without a bound
		// client — and does NOT create issues itself; that is `captureUnhandled`'s job below.
		const baseFetch = AppLive.pipe(Layer.provide(SentryEffectLive), HttpRouter.toHttpEffect);
		const fetch = Option.match(dsn, {
			onNone: () => baseFetch,
			onSome: (value) =>
				Effect.map(baseFetch, (httpEffect) =>
					Effect.gen(function* () {
						const request = yield* Cloudflare.Request;
						const context = yield* Cloudflare.WorkerExecutionContext;
						// Captured so the inner run inside `wrapRequestHandler`'s Promise thunk
						// keeps the request-scoped services — a bare `Effect.runPromise` would
						// start on the empty default context and lose them.
						const requestContext = yield* Effect.context<Effect.Services<typeof httpEffect>>();
						// alchemy types `makeRequestEffect` as `=> any` and pins its handler to the
						// `HttpEffect<Req>` alias, narrower than `toHttpEffect`'s inferred result;
						// the assertion states its real contract so alchemy's own SSE-scope-transfer
						// conversion is reused typed rather than re-forked.
						const toWebResponse = Cloudflare.makeRequestEffect as (
							webRequest: globalThis.Request,
							handler: typeof httpEffect,
						) => Effect.Effect<Response, never, Effect.Services<typeof httpEffect>>;
						// The swallow inside alchemy's `Http.safeHttpEffect` is why `captureErrors`
						// alone never fires; it stays a backstop for anything that still rejects
						// the thunk. Rationale in `sentry-capture.ts` (ADR 0118).
						const captured = captureUnhandled(httpEffect);
						const webResponse = yield* Effect.tryPromise({
							try: () =>
								wrapRequestHandler(
									{options: workerOptions(value), request, context, captureErrors: true},
									() =>
										Effect.runPromise(
											toWebResponse(request, captured).pipe(Effect.provide(requestContext)),
										),
								),
							catch: (cause) => new RequestHandlerError({cause}),
						}).pipe(Effect.orDie);
						return HttpServerResponse.fromWeb(webResponse);
					}),
				),
		});
		return {fetch};
	}).pipe(
		// One combined provide — chaining multiple `Effect.provide` can break layer
		// lifecycle.
		Effect.provide(
			Layer.mergeAll(
				LiveDOLive,
				// `provideMerge` keeps both `Database` (yielded in init) and `BetterAuth` in
				// scope while wiring the dependency in build order — a flat `mergeAll` would
				// run them in parallel and not wire it.
				BetterAuthLive.pipe(
					Layer.provideMerge(DatabaseLive),
					Layer.provide(
						EmailSenderLive.pipe(
							Layer.provide(Cloudflare.Email.SendBinding),
							Layer.provide(
								EmailDeliveryLogLive.pipe(Layer.provide(DrizzleLive), Layer.provide(DatabaseLive)),
							),
						),
					),
				),
				FlagshipLive.pipe(Layer.provide(Cloudflare.Flagship.ReadFlagsBinding)),
				Cloudflare.AnalyticsEngine.WriteDatasetBinding,
				Cloudflare.CronEventSourceLive,
			).pipe(Layer.provideMerge(Cloudflare.D1.QueryDatabaseBinding)),
		),
	),
);
