/**
 * The raw-`Request` HTTP routes (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * These endpoints want the *raw* `Request`/`Response`, not a schema, so they're
 * imperative `HttpRouter.add` routes:
 *
 *   - `* /api/auth/*` — better-auth. Delegated to the `BetterAuth` Context tag
 *     (`@alchemy.run/better-auth`): the layer (`BetterAuthLive`,
 *     `worker/features/pasaport/better-auth-live.ts`) constructs `makeBetterAuth(...)` once
 *     and exposes `.fetch` — an `HttpEffect` that forwards the inbound request
 *     to `auth.handler(...)` and returns the response. Same single global auth
 *     realm against the same D1 tables as `Pasaport.validateSession`.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

/**
 * `* /api/auth/*` — forward to better-auth's handler via the `BetterAuth`
 * Context tag. The layer constructs the auth instance once (per isolate) and
 * exposes `.fetch` as an `HttpEffect`; the route just yields it.
 */
export const handleAuth = Effect.gen(function* () {
	const betterAuth = yield* BetterAuth.BetterAuth;
	return yield* betterAuth.fetch;
});

export const authRoute = HttpRouter.add("*", "/api/auth/*", handleAuth);
