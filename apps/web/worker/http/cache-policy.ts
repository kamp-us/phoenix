import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Explicitly exclude viewer-dependent responses, including inherited CDN directives. */
export const privateResponse = (response: HttpServerResponse.HttpServerResponse) =>
	response.pipe(
		HttpServerResponse.removeHeader("cloudflare-cdn-cache-control"),
		HttpServerResponse.removeHeader("cdn-cache-control"),
		HttpServerResponse.removeHeader("expires"),
		HttpServerResponse.setHeader("cache-control", "private, no-store"),
	);

// Workers Cache otherwise stores headerless 200 responses for two hours. See ADR 0170.
export const CachePolicyLive = HttpRouter.middleware(
	(handler) =>
		Effect.map(handler, (response) =>
			response.headers["cache-control"] === undefined ? privateResponse(response) : response,
		),
	{global: true},
);
