/**
 * The raw-`Request` HTTP routes (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * These endpoints want the *raw* `Request`/`Response`, not a schema, so they're
 * imperative `HttpRouter.add` routes reading `Cloudflare.Request` and handing
 * the result back through `HttpServerResponse.fromWeb`:
 *
 *   - `* /api/auth/*` — better-auth. The handler is the same single global auth
 *     realm against the same D1 tables; `Pasaport.handleAuth` (a worker-level
 *     service) builds better-auth and runs its handler. No per-request runtime.
 *   - `* /agents/*` — the agent transport stub (ADR 0009). No product agent DOs
 *     remain on the worker, so this returns 404, exactly as the old Hono
 *     `routeAgentRequest(...) ?? 404` did once `routeAgentRequest` had nothing
 *     to dispatch to. Kept as a route so future per-atom agents plug in here
 *     without changing the router shape (out of scope for this migration).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../features/pasaport/Pasaport.ts";

/**
 * `* /api/auth/*` — forward the raw `Request` to better-auth's handler. The
 * worker-level `Pasaport` owns auth construction (same D1 tables); the route
 * just relays request → response.
 */
export const handleAuth = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const res = yield* pasaport.handleAuth(raw);
	return HttpServerResponse.fromWeb(res);
});

export const authRoute = HttpRouter.add("*", "/api/auth/*", handleAuth);

/** `* /agents/*` — the inert agent transport stub: always 404. */
export const agentsRoute = HttpRouter.add(
	"*",
	"/agents/*",
	HttpServerResponse.text("Not Found", {status: 404}),
);
