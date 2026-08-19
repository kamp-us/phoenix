/**
 * The `* /fate/live` route — the SSE transport endpoint (ADR 0023/0028,
 * `.patterns/alchemy-http-router.md`).
 *
 * Serves fate's native SSE live protocol from the unified `LiveDO` rather than fate's
 * in-Worker `handleLiveRequest`, which cannot fan out across isolates. It builds no
 * per-request runtime, and reaches the connection through the worker-init `LiveDO`
 * namespace via typed RPC plus a forwarded `fetch` — never
 * `idFromName`/`get`/`stub.fetch(string)`.
 *
 * There is no token in the URL or headers: the session cookie rides the request
 * automatically, since fate's `EventSource` is same-origin with `withCredentials`.
 */
import {FateRequestError} from "@nkzw/fate/server";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {NOTIFICATION_CHANNEL_TYPE} from "../bildirim/channel.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {LiveTransportError} from "./cold-start-retry.ts";
import {
	defaultLiveLimits,
	parseLiveControlRequest,
	type SubscribeControl,
	topicsForSubscribe,
} from "./protocol.ts";
import {LiveConnections} from "./topics.ts";

function liveError(code: string, message: string, status: number) {
	return HttpServerResponse.jsonUnsafe(
		{results: [{error: {code, message}, id: "live", ok: false}], version: 1},
		{status, headers: {"content-type": "application/json; charset=utf-8"}},
	);
}

export const handleLive = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const connections = yield* LiveConnections;

	const session = yield* pasaport.validateSession(raw.headers);
	if (!session) {
		return liveError("UNAUTHORIZED", "Live views require a session.", 401);
	}
	const ownerId = session.user.id;

	if (raw.method === "GET") {
		const connectionId = new URL(raw.url).searchParams.get("connectionId");
		if (!connectionId) {
			return liveError("BAD_REQUEST", "Missing connectionId.", 400);
		}
		// `ownerId` is threaded so the DO can reject a control message that
		// subscribes on another user's behalf.
		const forward = new Request(
			`https://live/connect?connectionId=${encodeURIComponent(connectionId)}&ownerId=${encodeURIComponent(ownerId)}&maxQueuedEventsPerConnection=${defaultLiveLimits.maxQueuedEventsPerConnection}`,
			{headers: raw.headers},
		);
		// A cold-DO transport failure that survived the retry renders a graceful 503 (the
		// live pin retries on the next mount); only a real framing error stays a defect.
		return yield* connections.open(connectionId, HttpServerRequest.fromWeb(forward)).pipe(
			Effect.catchTag("fate-live/LiveTransportError", (error) =>
				Effect.succeed(liveError("LIVE_UNAVAILABLE", error.message, 503)),
			),
			Effect.orDie,
		);
	}

	if (raw.method === "POST") {
		const decoded = yield* Effect.tryPromise({
			try: () => raw.json(),
			catch: () => new FateRequestError("BAD_REQUEST", "Body must be valid JSON."),
		}).pipe(Effect.flatMap(parseLiveControlRequest), Effect.result);
		if (decoded._tag === "Failure") {
			const error = decoded.failure;
			return liveError(error.code, error.message, error.status);
		}
		const body = decoded.success;
		const connectionId = body.connectionId;
		const results: Array<{id: string; ok: boolean; data: null}> = [];
		for (const operation of body.operations) {
			if (operation.kind === "unsubscribe") {
				yield* connections.unsubscribe(connectionId, operation.id);
				results.push({id: operation.id, ok: true, data: null});
				continue;
			}
			// This is the authorization seam for recipient-scoped topics (#1700). The
			// entity id is client-supplied and the DO's owner check guards only the
			// CONNECTION owner, so without this a subscribe could watch another user's
			// notification stream.
			if (
				operation.kind === "subscribe" &&
				operation.type === NOTIFICATION_CHANNEL_TYPE &&
				String(operation.entityId) !== ownerId
			) {
				results.push({id: operation.id, ok: false, data: null});
				continue;
			}
			const control: SubscribeControl =
				operation.kind === "subscribe"
					? {
							kind: "subscribe",
							subId: operation.id,
							type: operation.type,
							entityId: String(operation.entityId),
							...(operation.lastEventId !== undefined ? {lastEventId: operation.lastEventId} : {}),
						}
					: {
							kind: "subscribeConnection",
							subId: operation.id,
							procedure: operation.procedure,
							...(operation.args ? {args: operation.args} : {}),
							...(operation.lastEventId !== undefined ? {lastEventId: operation.lastEventId} : {}),
						};
			// Limits are resolved here so the DO records the subscription with a budget it
			// never invents, and `lastEventId` rides through so the topic replays only
			// frames newer than the last one this subscription saw (#714).
			const res = yield* connections.subscribe(connectionId, {
				subId: operation.id,
				topics: topicsForSubscribe(control),
				ownerId,
				limits: defaultLiveLimits,
				...(control.lastEventId !== undefined ? {lastEventId: control.lastEventId} : {}),
			});
			results.push({id: operation.id, ok: res.ok, data: null});
		}
		return HttpServerResponse.jsonUnsafe(
			{results, version: 1},
			{headers: {"content-type": "application/json; charset=utf-8"}},
		);
	}

	return liveError("BAD_REQUEST", "Invalid live request.", 400);
}).pipe(
	// Same 503-not-500 handling for the POST control loop (#842); the GET path handles
	// its own locally.
	Effect.catchTag("fate-live/LiveTransportError", (error: LiveTransportError) =>
		Effect.succeed(liveError("LIVE_UNAVAILABLE", error.message, 503)),
	),
);

export const liveRoute = HttpRouter.add("*", "/fate/live", handleLive);
