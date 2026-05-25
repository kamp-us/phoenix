/**
 * The `* /fate/live` route — the SSE transport endpoint (ADR 0023/0028,
 * `.patterns/alchemy-http-router.md`).
 *
 * Serves fate's native SSE live protocol from the `ConnectionDO` rather than
 * fate's in-Worker `handleLiveRequest` (which cannot fan out across isolates).
 * It builds **no** per-request runtime: the session check rides the worker-level
 * `Pasaport` (the same service `/fate` and `/api/auth/*` use), and the connection
 * is reached through the worker-init-resolved `ConnectionDO` namespace (carried
 * by `LiveConnections`) — addressed by name (`connection:${id}`) and driven by
 * typed RPC + a forwarded `fetch`, never `idFromName`/`get`/`stub.fetch(string)`.
 *
 *   - `GET  /fate/live?connectionId=…` → validate cookie, forward the request to
 *     the connection DO's `fetch` to open the SSE stream. Rejected (401) without
 *     a valid session cookie.
 *   - `POST /fate/live` → a `subscribe`/`subscribeConnection`/`unsubscribe`
 *     control message; validate cookie, drive the connection DO's typed RPC.
 *
 * The session cookie rides the request automatically (fate opens the
 * `EventSource` with `withCredentials: true`, same-origin), so there is no token
 * in the URL and no header. This is an imperative `HttpRouter.add` route reading
 * `Cloudflare.Request`; its `Pasaport`/`LiveConnections` requirements are
 * discharged with `HttpRouter.provideRequest` in `http/app.ts`.
 */
import {FateRequestError} from "@nkzw/fate/server";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../features/pasaport/Pasaport.ts";
import {assertLiveControlRequest, type SubscribeControl} from "./live-protocol.ts";
import {LiveConnections} from "./live-topics.ts";

/**
 * The fate live error envelope (`{results: [{error}], version: 1}`). The SSE
 * client parses this shape for both the GET (connect) and POST (control) paths,
 * so it lives in exactly one place.
 */
function liveError(code: string, message: string, status: number) {
	return HttpServerResponse.jsonUnsafe(
		{results: [{error: {code, message}, id: "live", ok: false}], version: 1},
		{status, headers: {"content-type": "application/json; charset=utf-8"}},
	);
}

/**
 * `* /fate/live` — validate the session cookie, then either open the SSE stream
 * (GET) or drive a control message (POST) on the connection DO. Builds no
 * request runtime.
 */
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
		// Forward the inbound request to the connection DO's `fetch`, which opens
		// the held SSE stream and returns it verbatim (`fromWeb` carries the
		// stream through). `ownerId` is threaded so the DO can reject a control
		// message that subscribes on another user's behalf.
		const forward = new Request(
			`https://live/connect?connectionId=${encodeURIComponent(connectionId)}&ownerId=${encodeURIComponent(ownerId)}`,
			{headers: raw.headers},
		);
		return yield* connections
			.open(connectionId, HttpServerRequest.fromWeb(forward))
			.pipe(Effect.orDie);
	}

	if (raw.method === "POST") {
		let body: ReturnType<typeof assertLiveControlRequest>;
		try {
			body = assertLiveControlRequest(yield* Effect.promise(() => raw.json()));
		} catch (error) {
			if (error instanceof FateRequestError) {
				return liveError(error.code, error.message, error.status);
			}
			return liveError("BAD_REQUEST", "Body must be valid JSON.", 400);
		}
		const connectionId = body.connectionId;
		const results: Array<{id: string; ok: boolean; data: null}> = [];
		for (const operation of body.operations) {
			if (operation.kind === "unsubscribe") {
				yield* connections.unsubscribe(connectionId, operation.id);
				results.push({id: operation.id, ok: true, data: null});
				continue;
			}
			const control: SubscribeControl =
				operation.kind === "subscribe"
					? {
							kind: "subscribe",
							subId: operation.id,
							type: operation.type,
							entityId: String(operation.entityId),
						}
					: {
							kind: "subscribeConnection",
							subId: operation.id,
							procedure: operation.procedure,
							...(operation.args ? {args: operation.args} : {}),
						};
			const res = yield* connections.subscribe(connectionId, {control, ownerId});
			results.push({id: operation.id, ok: res.ok, data: null});
		}
		return HttpServerResponse.jsonUnsafe(
			{results, version: 1},
			{headers: {"content-type": "application/json; charset=utf-8"}},
		);
	}

	return liveError("BAD_REQUEST", "Invalid live request.", 400);
});

/** The `* /fate/live` route as a router layer, ready to merge into `AppLive`. */
export const liveRoute = HttpRouter.add("*", "/fate/live", handleLive);
