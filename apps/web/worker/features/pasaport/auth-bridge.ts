/**
 * The `/api/auth/*` bridge boundary, shared by the live layer and the test layer so both
 * answer a handler rejection with one shape (#4935).
 *
 * A rejection out of better-auth's own `handler` is infra, not a caller mistake, and the
 * caller must still be able to tell it apart from an auth denial — so it answers `503` with a
 * stable `code`, while the raw `cause` goes to the worker log only. `/api/auth/*` is
 * unauthenticated, so nothing driver-shaped may reach the body.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class BetterAuthHandlerError extends Schema.TaggedErrorClass<BetterAuthHandlerError>()(
	"pasaport/BetterAuthHandlerError",
	{cause: Schema.Defect()},
) {}

/** The machine-readable discriminator a caller branches on. */
export const AUTH_BRIDGE_UNAVAILABLE_CODE = "AUTH_BRIDGE_UNAVAILABLE";

export const AUTH_BRIDGE_UNAVAILABLE_STATUS = 503;

const unavailableResponse = HttpServerResponse.jsonUnsafe(
	{
		code: AUTH_BRIDGE_UNAVAILABLE_CODE,
		message: "Sign-in is temporarily unavailable. Try again in a moment.",
	},
	{status: AUTH_BRIDGE_UNAVAILABLE_STATUS},
);

/**
 * The `BetterAuth.fetch` body: run `handle` over the raw request, and turn its rejection into
 * the unavailable response instead of a defect (which died with `content-length: 0`).
 */
export const authBridgeFetch = (
	handle: (request: Request) => Promise<Response>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	never,
	HttpServerRequest.HttpServerRequest
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		return yield* Effect.tryPromise({
			try: () => handle(request.source as Request),
			catch: (cause) => new BetterAuthHandlerError({cause}),
		}).pipe(
			Effect.map(HttpServerResponse.fromWeb),
			Effect.catchTag("pasaport/BetterAuthHandlerError", (error) =>
				Effect.logError("[pasaport.authBridge] better-auth handler rejected", error.cause).pipe(
					Effect.as(unavailableResponse),
				),
			),
		);
	});
