/**
 * The `/fate/live` route — the SSE transport endpoint.
 *
 * This route serves fate's native SSE live protocol from the `ConnectionDO`
 * rather than from fate's in-Worker `handleLiveRequest` (which cannot fan
 * out across isolates). It builds **no** per-request `ManagedRuntime`: the DO
 * relays the inline-resolved `data`/`node` mutations publish, so there is no
 * Effect runtime in the live path. The only Effect here is the session cookie
 * check, shared with `/fate` via `validateSessionCookie` — a minimal
 * Pasaport-only runtime disposed before handoff, not the request runtime.
 *
 *   - `GET  /fate/live?connectionId=…` → validate cookie, open the SSE stream on
 *     the connection DO. Rejected (401) without a valid session cookie.
 *   - `POST /fate/live` → a `subscribe`/`subscribeConnection`/`unsubscribe`
 *     control message; validate cookie, forward to the connection DO.
 *
 * The session cookie rides the request automatically (fate opens the
 * `EventSource` with `withCredentials: true`, same-origin), so there is no token
 * in the URL and no header. See `.patterns/fate-live-views.md` (Auth), ADR 0023.
 */
import {FateRequestError} from "@nkzw/fate/server";
import type {Context} from "hono";
import {assertLiveControlRequest, type SubscribeControl} from "./live-protocol";
import {validateSessionCookie} from "./runtime";

/**
 * Build the fate live error envelope (`{results: [{error}], version: 1}`). The
 * SSE client parses this shape for both the GET (connect) and POST (control)
 * paths, so it lives in exactly one place.
 */
function liveError(code: string, message: string, status: number): Response {
	return Response.json(
		{results: [{error: {code, message}, id: "live", ok: false}], version: 1},
		{status, headers: {"content-type": "application/json; charset=utf-8"}},
	);
}

/** Resolve the connection-role DO stub for a connection id. */
function connectionStub(env: Env, connectionId: string) {
	return env.CONNECTION_DO.get(env.CONNECTION_DO.idFromName(`connection:${connectionId}`));
}

/**
 * Handle a `/fate/live` request. Validates the session cookie, then either opens
 * the SSE stream (GET) or forwards a control message (POST) to the connection DO.
 * Builds no request runtime.
 */
export async function handleLiveRequest(c: Context<{Bindings: Env}>): Promise<Response> {
	const request = c.req.raw;
	const session = await validateSessionCookie(c.env, request);
	if (!session) {
		return liveError("UNAUTHORIZED", "Live views require a session.", 401);
	}
	const ownerId = session.user.id;

	if (request.method === "GET") {
		const connectionId = new URL(request.url).searchParams.get("connectionId");
		if (!connectionId) {
			return liveError("BAD_REQUEST", "Missing connectionId.", 400);
		}
		const stub = connectionStub(c.env, connectionId);
		return stub.fetch(`https://live/connect?ownerId=${encodeURIComponent(ownerId)}`);
	}

	if (request.method === "POST") {
		let body: ReturnType<typeof assertLiveControlRequest>;
		try {
			body = assertLiveControlRequest(await request.json());
		} catch (error) {
			if (error instanceof FateRequestError) {
				return liveError(error.code, error.message, error.status);
			}
			return liveError("BAD_REQUEST", "Body must be valid JSON.", 400);
		}
		const stub = connectionStub(c.env, body.connectionId);
		const results: Array<{id: string; ok: boolean; data: null; error?: unknown}> = [];
		for (const operation of body.operations) {
			if (operation.kind === "unsubscribe") {
				await stub.fetch("https://live/unsubscribe", {
					method: "POST",
					body: JSON.stringify({subId: operation.id}),
				});
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
			const res = await stub.fetch("https://live/subscribe", {
				method: "POST",
				body: JSON.stringify({control, ownerId}),
			});
			results.push({id: operation.id, ok: res.ok, data: null});
		}
		return Response.json(
			{results, version: 1},
			{headers: {"content-type": "application/json; charset=utf-8"}},
		);
	}

	return liveError("BAD_REQUEST", "Invalid live request.", 400);
}
