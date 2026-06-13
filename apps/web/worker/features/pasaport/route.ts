/**
 * `* /api/auth/*` — better-auth, as a raw-`Request` `HttpRouter.add` route (ADR
 * 0027). Delegates to the `BetterAuth` tag's `.fetch` `HttpEffect`, which forwards
 * the request to `auth.handler(...)` — same auth realm and D1 tables as
 * `Pasaport.validateSession`.
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

export const handleAuth = Effect.gen(function* () {
	const betterAuth = yield* BetterAuth.BetterAuth;
	return yield* betterAuth.fetch;
});

export const authRoute = HttpRouter.add("*", "/api/auth/*", handleAuth);
