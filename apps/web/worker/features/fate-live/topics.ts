/**
 * `LiveTopics` — the worker-level handle the `/fate` route fans a publish out
 * through (ADR 0028/0029). The namespace resolves once in worker init, so the
 * per-request route needs no `env` lookup. Publishes are typed RPC addressed through
 * `live-do.ts` (never `idFromName` or a string-URL `stub.fetch`), run inside
 * `waitUntil` so the fan-out doesn't block the response.
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
		// `LiveTransportError` is the truthful channel the alchemy stub's `never` hides
		// (#842, #2551): a publish to an idle-evicted `topic:` DO can fail on the cold
		// first RPC, so the worker seam retries and surfaces this on exhaustion. The
		// publisher then swallows-and-logs it — a publish must never fail a committed
		// mutation.
		readonly publish: (
			topicKey: string,
			message: PublishMessage,
			limits: LiveLimits,
		) => Effect.Effect<void, LiveTransportError, never>;
	}
>()("@kampus/LiveTopics") {}

// The `/fate/live` counterpart (ADR 0028). Connections are addressed through
// `connectionOf(live, connectionId)`, never `idFromName`/`get` on the alchemy stub.
export class LiveConnections extends Context.Service<
	LiveConnections,
	{
		// `LiveTransportError` is the bounded-retry-exhausted cold-start failure (#842).
		readonly open: (
			connectionId: string,
			request: HttpServerRequest.HttpServerRequest,
		) => Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			HttpServerError | LiveTransportError,
			never
		>;
		// On retry exhaustion the route renders a 503 envelope rather than a
		// defect-500 (#842).
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
		readonly unsubscribe: (
			connectionId: string,
			subId: string,
		) => Effect.Effect<{readonly ok: true}, LiveTransportError, never>;
	}
>()("@kampus/LiveConnections") {}
