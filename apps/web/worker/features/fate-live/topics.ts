/**
 * `LiveTopics` — the worker-level handle the `/fate` route uses to fan a publish
 * out to the `LiveDO` namespace's topic-role instances (ADR 0028/0029). The
 * namespace is resolved once in worker init, wrapped as a `Context.Service` so the
 * per-request route reaches it without an `env`-based lookup. `publish` is a typed
 * RPC addressed through `live-do.ts`'s seam — no `idFromName`, no string-URL
 * `stub.fetch` — run inside `waitUntil` so the fan-out doesn't block the response.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {HttpServerError} from "effect/unstable/http/HttpServerError";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {LiveTransportError} from "./cold-start-retry.ts";
import type {LiveLimits, PublishMessage} from "./protocol.ts";

export class LiveTopics extends Context.Service<
	LiveTopics,
	{
		/**
		 * Fire the typed `LiveDO.publish` RPC for one resolved topic key.
		 * `LiveTransportError` is the truthful channel the alchemy stub's `never`
		 * hides (#842, #2551): a publish to an idle-evicted `topic:` DO can fail on
		 * the cold first RPC, so the worker seam wraps this in `withColdStartRetry`
		 * (the same bounded retry the sibling `subscribe`/`unsubscribe` use) and
		 * surfaces this on exhaustion. The publisher swallows-and-logs it best-effort
		 * off the request path — a publish still must not fail the committed mutation.
		 */
		readonly publish: (
			topicKey: string,
			message: PublishMessage,
			limits: LiveLimits,
		) => Effect.Effect<void, LiveTransportError, never>;
	}
>()("@kampus/LiveTopics") {}

/**
 * `LiveConnections` — the worker-level handle the `/fate/live` route uses to
 * reach the `LiveDO` namespace's connection-role instances (ADR 0028). Opens the
 * SSE stream by forwarding the inbound request to a connection's `fetch`, and
 * records/drops subscriptions via typed RPC. Connections are addressed through
 * `connectionOf(live, connectionId)` — no `idFromName`/`get` on the alchemy stub.
 */
export class LiveConnections extends Context.Service<
	LiveConnections,
	{
		/**
		 * Forward the (request-shaped) SSE upgrade to a connection DO's `fetch`.
		 * `LiveTransportError` is the bounded-retry-exhausted cold-start failure
		 * (#842); the worker seam wraps the cross-DO call in `withColdStartRetry`.
		 */
		readonly open: (
			connectionId: string,
			request: HttpServerRequest.HttpServerRequest,
		) => Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			HttpServerError | LiveTransportError,
			never
		>;
		/**
		 * Record a subscription on a connection (typed RPC). `LiveTransportError` is
		 * the truthful error channel the alchemy stub's `never` hid (#842): the
		 * worker seam retries a cold-DO transport failure and surfaces this on
		 * exhaustion, so the route renders a 503 envelope instead of a defect-500.
		 */
		readonly subscribe: (
			connectionId: string,
			input: {
				readonly subId: string;
				readonly topics: ReadonlyArray<string>;
				readonly ownerId: string | undefined;
				readonly limits: LiveLimits;
				readonly lastEventId?: string;
			},
		) => Effect.Effect<{readonly ok: boolean}, LiveTransportError, never>;
		/** Drop a subscription on a connection (typed RPC). */
		readonly unsubscribe: (
			connectionId: string,
			subId: string,
		) => Effect.Effect<{readonly ok: true}, LiveTransportError, never>;
	}
>()("@kampus/LiveConnections") {}
