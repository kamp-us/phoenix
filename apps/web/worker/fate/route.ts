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
import {Pasaport} from "../features/pasaport/Pasaport.ts";
import {Auth, RequestContext} from "../services/index.ts";
import type {FateEnv} from "./layers.ts";
import {livePublishContext} from "./live.ts";
import {fateServer} from "./server.ts";

/**
 * `POST /fate` — the fate data plane. Resolves the session through the
 * worker-level `Pasaport`, captures the per-request `Context`, sets up the live
 * publish context, and serves fate over the captured map.
 */
export const handleFate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const env = yield* Cloudflare.WorkerEnvironment;
	const executionCtx = yield* Cloudflare.WorkerExecutionContext;
	const pasaport = yield* Pasaport;

	const session = yield* pasaport.validateSession(raw.headers);

	const res = yield* Effect.gen(function* () {
		// Capture the live service map — at this point it holds the worker-level
		// services (Drizzle, features) plus the per-request Auth/RequestContext
		// provided just below, so it carries the full `FateEnv`. The bridge
		// provides it onto each resolver Effect.
		const context = yield* Effect.context<FateEnv>();
		return yield* Effect.promise(() =>
			// `livePublishContext.run` keeps `{env, waitUntil}` ambient for the whole
			// (async) `handleRequest`, so a mutation's synchronous `live.*` calls can
			// fan out to the topic DO via `waitUntil`. AsyncLocalStorage preserves the
			// store across the awaits inside `handleRequest`. A query publishes
			// nothing, so the wrapper is harmless there.
			livePublishContext.run(
				{
					env: env as unknown as Env,
					waitUntil: (promise) => executionCtx.waitUntil(promise),
				},
				() => fateServer.handleRequest(raw, {request: raw, context}),
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
