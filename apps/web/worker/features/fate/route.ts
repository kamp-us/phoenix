/**
 * The `POST /fate` route (ADR 0029, `.patterns/alchemy-http-router.md`).
 *
 * The worker provides `Drizzle` + the feature services as worker-level layers
 * (built once in init — see `layers.ts`). This route is the per-request seam:
 *
 *   1. Read the raw `Request` (`Cloudflare.Request`), the env, and the execution
 *      context.
 *   2. Validate the session through the worker-level `Pasaport` — no throwaway
 *      runtime (this replaces the old `validateSessionCookie`).
 *   3. Provide the genuinely per-request services — `Auth` (the validated
 *      session) and `LiveBus` (the publish capability, ADR 0039) — and pick up
 *      the upstream `HttpServerRequest` Tag the alchemy/HttpRouter runtime already
 *      provides; then capture the live service map with `Effect.context<FateEnv>()`
 *      and hand it to fate through `adapterContext` as `{context, request}`.
 *   4. `LiveBus` closes over a per-request publisher so a mutation's `live.*`
 *      fan-out reaches the topic DO without blocking the response — `waitUntil`
 *      comes from `Cloudflare.WorkerExecutionContext` (ADR 0029), not a disposed
 *      runtime. There is no `AsyncLocalStorage` bridge (ADR 0039): the bus is
 *      provided into the captured context like `Auth`, so a missing provide fails
 *      loudly instead of silently no-opping.
 *
 * Nothing is built or disposed per request: the bridge runs each resolver with
 * `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` (see `effect.ts`).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {LiveBus, liveBusFor} from "../fate-live/event-bus.ts";
import {defaultLiveLimits} from "../fate-live/route.ts";
import {LiveTopics} from "../fate-live/topics.ts";
import {Auth} from "../pasaport/Auth.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {FateEnv} from "./layers.ts";
import {fateServer} from "./server.ts";

/**
 * `POST /fate` — the fate data plane. Resolves the session through the
 * worker-level `Pasaport`, captures the per-request `Context`, provides the
 * per-request `Auth` + `LiveBus`, and serves fate over the captured map.
 */
export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;
	const liveTopics = yield* LiveTopics;

	const session = yield* pasaport.validateSession(raw.headers);

	// The per-request live publisher (ADR 0028/0029/0039): a mutation's synchronous
	// `live.*` call resolves topic keys and fires the typed `TopicDO.publish` RPC
	// here. The topic namespace is worker-init-resolved (carried by `LiveTopics`,
	// no `env` lookup, no `idFromName`, no string-URL `stub.fetch`); `waitUntil`
	// comes from `Cloudflare.WorkerExecutionContext` so the best-effort fan-out
	// doesn't block the response. A failed publish is swallowed loudly — the
	// mutation response already succeeded.
	const publisher = (topicKey: string, message: Parameters<typeof liveTopics.publish>[1]) => {
		executionCtx.waitUntil(
			// Deliberate Effect→Promise boundary: this fire-and-forget publish is
			// handed to `waitUntil` (a Promise sink) outside the request fiber.
			// `liveTopics.publish` is self-contained (R = never), so it needs no
			// surrounding services — `runPromise` is correct, not `runPromiseWith`.
			// @effect-diagnostics-next-line effect/runEffectInsideEffect:off
			Effect.runPromise(liveTopics.publish(topicKey, message, defaultLiveLimits)).catch(
				(error: unknown) => {
					console.error(`live publish to topic:${topicKey} failed`, error);
				},
			),
		);
	};

	const res = yield* Effect.gen(function* () {
		// Capture the live service map — at this point it holds the worker-level
		// services (Drizzle, features), the per-request `Auth` + `LiveBus` provided
		// just below, and the `HttpServerRequest` Tag the alchemy/HttpRouter runtime
		// already provides — so it carries the full `FateEnv`. The bridge provides it
		// onto each resolver Effect.
		const context = yield* Effect.context<FateEnv>();
		return yield* Effect.promise(() => fateServer.handleRequest(raw, {request: raw, context}));
	}).pipe(
		Effect.provideService(Auth, {
			user: session?.user,
			session: session?.session,
		}),
		// The per-request publish capability (ADR 0039): mutations acquire it with
		// `yield* LiveBus` and wrap each publish in `useIgnore`. Provided here exactly
		// where `Auth` is — there is no `AsyncLocalStorage` bridge; a missing provide
		// fails loudly instead of silently no-opping.
		Effect.provideService(LiveBus, liveBusFor(publisher)),
	);

	return HttpServerResponse.fromWeb(res);
});

/** The `/fate` route as a router layer, ready to merge into `AppLive`. */
export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
