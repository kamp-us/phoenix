/**
 * `LiveTopics` — the worker-level handle the `/fate` route uses to fan a publish
 * out to the `TopicDO` namespace (ADR 0028/0029).
 *
 * The `TopicDO` namespace is resolved **once in worker init** (`index.ts`),
 * wrapped here as a `Context.Service` so the per-request `/fate` route can reach
 * it without an `env`-based lookup. `publish(topicKey, message)` is a typed RPC —
 * `topics.getByName(\`topic:${topicKey}\`).publish(message)` — with no
 * `idFromName`/`idFromString` and no string-URL `stub.fetch`. The route runs this
 * inside `Cloudflare.WorkerExecutionContext.waitUntil` so the best-effort live
 * fan-out doesn't block the mutation response.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {HttpServerError} from "effect/unstable/http/HttpServerError";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {PublishMessage, SubscribeControl} from "./live-protocol.ts";

export class LiveTopics extends Context.Service<
	LiveTopics,
	{
		/**
		 * Fire the typed `TopicDO.publish` RPC for one resolved topic key. Returns
		 * an Effect the route runs (fired-and-forgotten via `waitUntil`); it cannot
		 * fail (the DO RPC's errors are swallowed best-effort at the call site).
		 */
		readonly publish: (
			topicKey: string,
			message: PublishMessage,
		) => Effect.Effect<void, never, never>;
	}
>()("@phoenix/LiveTopics") {}

/**
 * `LiveConnections` — the worker-level handle the `/fate/live` route uses to
 * reach the `ConnectionDO` namespace (ADR 0028). The namespace is resolved once
 * in worker init; the route opens the SSE stream by forwarding the inbound
 * request to a connection's `fetch`, and records/drops subscriptions via the
 * typed `subscribe`/`unsubscribe` RPC. Connections are addressed by name
 * (`connection:${connectionId}`) — no `idFromName`/`get` on the alchemy stub.
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
			input: {readonly control: SubscribeControl; readonly ownerId: string | undefined},
		) => Effect.Effect<{readonly ok: boolean}, never, never>;
		/** Drop a subscription on a connection (typed RPC). */
		readonly unsubscribe: (
			connectionId: string,
			subId: string,
		) => Effect.Effect<{readonly ok: true}, never, never>;
	}
>()("@phoenix/LiveConnections") {}
