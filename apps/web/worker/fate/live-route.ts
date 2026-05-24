/**
 * The `/fate/live` route — the SSE transport endpoint.
 *
 * This route serves fate's native SSE live protocol from the `LiveDO` Durable
 * Object rather than from fate's in-Worker `handleLiveRequest` (which cannot fan
 * out across isolates). It builds **no** per-request `ManagedRuntime`: the DO
 * relays the inline-resolved `data`/`node` mutations publish, so there is no
 * Effect runtime in the live path. The only Effect here is the short-lived
 * session validation (the same cookie check the `/fate` route does) — and that
 * runs through a runtime disposed before handoff, not the request runtime.
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
import {Effect} from "effect";
import type {Context} from "hono";
import type {Session} from "../features/pasaport/auth";
import {Pasaport} from "../features/pasaport/Pasaport";
import {FateRuntime} from "./runtime";

/** Validate the better-auth session cookie via a short-lived runtime. */
async function validateSession(env: Env, request: Request): Promise<Session | null> {
	const sessionRuntime = FateRuntime.make(env, request, null);
	try {
		return await sessionRuntime.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.validateSession(request.headers);
			}),
		);
	} finally {
		await sessionRuntime.dispose();
	}
}

/** A subscribe/unsubscribe control operation from a fate live control POST. */
interface LiveControlOperation {
	id: string;
	kind: "subscribe" | "subscribeConnection" | "unsubscribe";
	type?: string;
	entityId?: string | number;
	procedure?: string;
	args?: Record<string, unknown>;
	[key: string]: unknown;
}

/** A fate live control request body. */
interface LiveControlBody {
	version: number;
	connectionId: string;
	operations: ReadonlyArray<LiveControlOperation>;
}

/** Resolve the connection-role DO stub for a connection id. */
function connectionStub(env: Env, connectionId: string) {
	return env.LIVE_DO.get(env.LIVE_DO.idFromName(`connection:${connectionId}`));
}

/**
 * Handle a `/fate/live` request. Validates the session cookie, then either opens
 * the SSE stream (GET) or forwards a control message (POST) to the connection DO.
 * Builds no request runtime.
 */
export async function handleLiveRequest(c: Context<{Bindings: Env}>): Promise<Response> {
	const request = c.req.raw;
	const session = await validateSession(c.env, request);
	if (!session) {
		return Response.json(
			{
				results: [
					{
						error: {code: "UNAUTHORIZED", message: "Live views require a session."},
						id: "live",
						ok: false,
					},
				],
				version: 1,
			},
			{status: 401, headers: {"content-type": "application/json; charset=utf-8"}},
		);
	}
	const ownerId = session.user.id;

	if (request.method === "GET") {
		const connectionId = new URL(request.url).searchParams.get("connectionId");
		if (!connectionId) {
			return Response.json(
				{
					results: [
						{error: {code: "BAD_REQUEST", message: "Missing connectionId."}, id: "live", ok: false},
					],
					version: 1,
				},
				{status: 400, headers: {"content-type": "application/json; charset=utf-8"}},
			);
		}
		const stub = connectionStub(c.env, connectionId);
		return stub.fetch(`https://live/connect?ownerId=${encodeURIComponent(ownerId)}`);
	}

	if (request.method === "POST") {
		let body: LiveControlBody;
		try {
			body = (await request.json()) as LiveControlBody;
		} catch {
			return Response.json(
				{
					results: [
						{
							error: {code: "BAD_REQUEST", message: "Body must be valid JSON."},
							id: "live",
							ok: false,
						},
					],
					version: 1,
				},
				{status: 400, headers: {"content-type": "application/json; charset=utf-8"}},
			);
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
			const control =
				operation.kind === "subscribe"
					? {
							kind: "subscribe" as const,
							subId: operation.id,
							type: operation.type ?? "",
							entityId: String(operation.entityId ?? ""),
						}
					: {
							kind: "subscribeConnection" as const,
							subId: operation.id,
							procedure: operation.procedure ?? "",
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

	return Response.json(
		{
			results: [
				{error: {code: "BAD_REQUEST", message: "Invalid live request."}, id: "live", ok: false},
			],
			version: 1,
		},
		{status: 400, headers: {"content-type": "application/json; charset=utf-8"}},
	);
}
