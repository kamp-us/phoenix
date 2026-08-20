/**
 * The `/api/auth/*` rejection shape (#4935): a handler that rejects must not answer a bare
 * `500` with an empty body, and must not put the driver text in it either.
 */
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {describe, expect, it} from "vitest";
import {
	AUTH_BRIDGE_UNAVAILABLE_CODE,
	AUTH_BRIDGE_UNAVAILABLE_STATUS,
	authBridgeFetch,
} from "./auth-bridge.ts";

const D1_REJECTION = "D1_ERROR: Failed to parse body as JSON, got: error code: 1031";

const runBridge = (handle: (request: Request) => Promise<Response>) =>
	Effect.runPromise(
		authBridgeFetch(handle).pipe(
			Effect.map((response) => HttpServerResponse.toWeb(response)),
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(new Request("http://localhost:3000/api/auth/sign-up/email")),
			),
		),
	);

describe("authBridgeFetch", () => {
	it("passes a handler response straight through", async () => {
		const response = await runBridge(async () => new Response('{"ok":true}', {status: 200}));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"ok":true}');
	});

	it("answers a rejection with a discriminable status and a non-empty body", async () => {
		const response = await runBridge(async () => {
			throw new Error(D1_REJECTION);
		});
		const body = await response.text();

		expect(response.status).toBe(AUTH_BRIDGE_UNAVAILABLE_STATUS);
		expect(body).not.toBe("");
		expect(JSON.parse(body).code).toBe(AUTH_BRIDGE_UNAVAILABLE_CODE);
	});

	it("keeps the driver detail out of the body", async () => {
		const response = await runBridge(async () => {
			throw new Error(D1_REJECTION);
		});
		const body = await response.text();

		expect(body).not.toContain("D1_ERROR");
		expect(body).not.toContain("1031");
	});
});
