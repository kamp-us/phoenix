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
import type {LiveLimits, PublishMessage} from "./protocol.ts";

export class LiveTopics extends Context.Service<
	LiveTopics,
	{
		/**
		 * Fire the typed `LiveDO.publish` RPC for one resolved topic key. Cannot
		 * fail — the DO RPC's errors are swallowed best-effort at the call site.
		 */
		readonly publish: (
			topicKey: string,
			message: PublishMessage,
			limits: LiveLimits,
		) => Effect.Effect<void, never, never>;
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
		/** Forward the (request-shaped) SSE upgrade to a connection DO's `fetch`. */
		readonly open: (
			connectionId: string,
			request: HttpServerRequest.HttpServerRequest,
		) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError, never>;
		/** Record a subscription on a connection (typed RPC). */
		readonly subscribe: (
			connectionId: string,
			input: {
				readonly subId: string;
				readonly topics: ReadonlyArray<string>;
				readonly ownerId: string | undefined;
				readonly limits: LiveLimits;
				readonly lastEventId?: string;
			},
		) => Effect.Effect<{readonly ok: boolean}, never, never>;
		/** Drop a subscription on a connection (typed RPC). */
		readonly unsubscribe: (
			connectionId: string,
			subId: string,
		) => Effect.Effect<{readonly ok: true}, never, never>;
	}
>()("@kampus/LiveConnections") {}
