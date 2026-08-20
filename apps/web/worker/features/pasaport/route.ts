/**
 * `* /api/auth/*` — better-auth, as a raw-`Request` `HttpRouter.add` route (ADR 0027). Delegates
 * to the `BetterAuth` tag's `.fetch`, so it shares the auth realm and D1 tables with
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
