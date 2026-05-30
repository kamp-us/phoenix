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
 *   3. Provide the two genuinely per-request services — `Auth` (the validated
 *      session) and `RequestContext` — then capture the live service map with
 *      `Effect.context<FateEnv>()` and hand it to fate through `adapterContext`
 *      as `{context, request}`.
 *   4. The publish-only live bus needs `{env, waitUntil}` in scope during the
 *      operation so a mutation's `live.*` fan-out reaches the topic DO without
 *      blocking the response — `waitUntil` comes from
 *      `Cloudflare.WorkerExecutionContext` (ADR 0029), not a disposed runtime.
 *
 * Nothing is built or disposed per request: the bridge runs each resolver with
 * `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` (see `effect.ts`).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {livePublishContext} from "../features/fate-live/event-bus.ts";
import {LiveTopics} from "../features/fate-live/topics.ts";
import {Pasaport} from "../features/pasaport/Pasaport.ts";
import {Auth, RequestContext} from "../services/index.ts";
import type {FateEnv} from "./layers.ts";
import {fateServer} from "./server.ts";

/**
 * `POST /fate` — the fate data plane. Resolves the session through the
 * worker-level `Pasaport`, captures the per-request `Context`, sets up the live
 * publish context, and serves fate over the captured map.
 */
export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;
	const liveTopics = yield* LiveTopics;

	const session = yield* pasaport.validateSession(raw.headers);

	// The per-request live publisher (ADR 0028/0029): a mutation's synchronous
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
			Effect.runPromise(liveTopics.publish(topicKey, message)).catch((error: unknown) => {
				console.error(`live publish to topic:${topicKey} failed`, error);
			}),
		);
	};

	const res = yield* Effect.gen(function* () {
		// Capture the live service map — at this point it holds the worker-level
		// services (Drizzle, features) plus the per-request Auth/RequestContext
		// provided just below, so it carries the full `FateEnv`. The bridge
		// provides it onto each resolver Effect.
		const context = yield* Effect.context<FateEnv>();
		return yield* Effect.promise(() =>
			// `livePublishContext.run` keeps the `publisher` ambient for the whole
			// (async) `handleRequest`, so a mutation's synchronous `live.*` calls can
			// fan out to the topic DO. AsyncLocalStorage preserves the store across
			// the awaits inside `handleRequest`. A query publishes nothing, so the
			// wrapper is harmless there.
			livePublishContext.run(publisher, () =>
				fateServer.handleRequest(raw, {request: raw, context}),
			),
		);
	}).pipe(
		Effect.provideService(Auth, {
			user: session?.user,
			session: session?.session,
		}),
		Effect.provideService(RequestContext, {
			headers: raw.headers,
			url: raw.url,
			method: raw.method,
		}),
	);

	return HttpServerResponse.fromWeb(res);
});

/** The `/fate` route as a router layer, ready to merge into `AppLive`. */
export const fateRoute = HttpRouter.add("POST", "/fate", handleFate);
