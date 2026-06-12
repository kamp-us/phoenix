/**
 * `LiveTopics` — the worker-level handle the `/fate` route uses to fan a publish
 * out to the `LiveDO` namespace's topic-role instances (ADR 0028/0029).
 *
 * The `LiveDO` namespace is resolved **once in worker init** (`index.ts`),
 * wrapped here as a `Context.Service` so the per-request `/fate` route can reach
 * it without an `env`-based lookup. `publish(topicKey, message, limits)` is a
 * typed RPC — `live.getByName(makeTopicName(topicKey)).publish({topicKey, frame,
 * limits})`, the name built by `live-do.ts`'s constructor (the one seam owning
 * the instance-name grammar) — with no `idFromName`/`idFromString` and no
 * string-URL `stub.fetch`.
 * The route builds the per-request {@link LiveLimits} and threads it through
 * (decision 2B: limits are per-call, never hardcoded in the DO). The route runs
 * this inside `Cloudflare.WorkerExecutionContext.waitUntil` so the best-effort
 * live fan-out doesn't block the mutation response.
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
		 * Fire the typed `LiveDO.publish` RPC for one resolved topic key, threading
		 * the per-request {@link LiveLimits}. Returns an Effect the route runs
		 * (fired-and-forgotten via `waitUntil`); it cannot fail (the DO RPC's errors
		 * are swallowed best-effort at the call site).
		 */
		readonly publish: (
			topicKey: string,
			message: PublishMessage,
			limits: LiveLimits,
		) => Effect.Effect<void, never, never>;
	}
>()("@phoenix/LiveTopics") {}

/**
 * `LiveConnections` — the worker-level handle the `/fate/live` route uses to
 * reach the `LiveDO` namespace's connection-role instances (ADR 0028). The
 * namespace is resolved once in worker init; the route opens the SSE stream by
 * forwarding the inbound request to a connection's `fetch`, and records/drops
 * subscriptions via the typed `subscribe`/`unsubscribe` RPC. Connections are
 * addressed by name (`makeConnectionName(connectionId)`, `live-do.ts`'s name
 * constructor) — no `idFromName`/`get` on the alchemy stub. The route resolves a subscribe's topic keys
 * (`topicsForSubscribe`) and builds the {@link LiveLimits} up front, threading
 * both into `subscribe` (decision 2B).
 */
export class LiveConnections extends Context.Service<
	LiveConnections,
	{
		/** Forward the (request-shaped) SSE upgrade to a connection DO's `fetch`. */
		readonly open: (
			connectionId: string,
			request: HttpServerRequest.HttpServerRequest,
		) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError, never>;
		/**
		 * Record a subscription on a connection (typed RPC). The route resolves the
		 * subscription's topic keys and the per-request limits before calling.
		 */
		readonly subscribe: (
			connectionId: string,
			input: {
				readonly subId: string;
				readonly topics: ReadonlyArray<string>;
				readonly ownerId: string | undefined;
				readonly limits: LiveLimits;
			},
		) => Effect.Effect<{readonly ok: boolean}, never, never>;
		/** Drop a subscription on a connection (typed RPC). */
		readonly unsubscribe: (
			connectionId: string,
			subId: string,
		) => Effect.Effect<{readonly ok: true}, never, never>;
	}
>()("@phoenix/LiveConnections") {}
