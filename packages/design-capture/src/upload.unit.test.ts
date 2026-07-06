/**
 * The upload-response parser (pure) and the `uploadAsset` Effect over a stubbed
 * transport (off-network, ADR 0082). These pin the FALLBACK contract — the
 * acceptance criterion that an upload failure degrades to `{hostedUrl: null,
 * uploadError}` (a diagnostic), never a silent drop and never a broken gate (the
 * undocumented `uploads.github.com/user-attachments/assets` endpoint may change
 * without notice — ADR 0165).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {parseUploadResponse, uploadAsset, uploadEndpoint} from "./upload.ts";

const HOSTED = "https://github.com/user-attachments/assets/0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("uploadEndpoint", () => {
	it("targets the undocumented endpoint with the repository_id query param", () => {
		assert.strictEqual(
			uploadEndpoint(1234177275),
			"https://uploads.github.com/user-attachments/assets?repository_id=1234177275",
		);
	});
});

describe("parseUploadResponse — the fallback classifier (pure core)", () => {
	it("extracts the hosted URL from a 2xx `href` body", () => {
		const o = parseUploadResponse({status: 201, body: JSON.stringify({href: HOSTED})});
		assert.strictEqual(o.hostedUrl, HOSTED);
		assert.strictEqual(o.uploadError, null);
	});

	it("also accepts a `url` field", () => {
		assert.strictEqual(
			parseUploadResponse({status: 200, body: JSON.stringify({url: HOSTED})}).hostedUrl,
			HOSTED,
		);
	});

	it("falls back on a 4xx status with a diagnostic naming the code", () => {
		const o = parseUploadResponse({status: 404, body: "Not Found"});
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /HTTP 404/);
	});

	it("falls back on a 5xx status", () => {
		const o = parseUploadResponse({status: 500, body: "boom"});
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /HTTP 500/);
	});

	it("falls back on an unparseable body (undocumented endpoint drift)", () => {
		const o = parseUploadResponse({status: 201, body: "<html>not json</html>"});
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /unparseable/);
	});

	it("falls back on a 2xx body with no hosted URL field", () => {
		const o = parseUploadResponse({status: 201, body: JSON.stringify({id: 5, name: "x.png"})});
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /no hosted URL/);
	});

	it("falls back on a URL that is not a GitHub user-attachments asset (never embeds a bogus link)", () => {
		const o = parseUploadResponse({
			status: 201,
			body: JSON.stringify({href: "https://evil.example/x"}),
		});
		assert.strictEqual(o.hostedUrl, null);
	});
});

/** A canned transport that returns one fixed web Response for every request. */
const stubResponse = (status: number, body: string): Layer.Layer<HttpClient.HttpClient> =>
	Layer.succeed(HttpClient.HttpClient)(
		HttpClient.make((request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, {status}))),
		),
	);

/** A transport that always fails at the transport layer (simulated network error). */
const stubTransportError: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(HttpClient.HttpClient)(
	HttpClient.make((request) =>
		Effect.fail(
			new HttpClientError.HttpClientError({
				reason: new HttpClientError.TransportError({
					request,
					description: "simulated network failure",
				}),
			}),
		),
	),
);

const runUpload = (layer: Layer.Layer<HttpClient.HttpClient>) =>
	Effect.runPromise(
		uploadAsset({
			pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			repositoryId: 1234177275,
			token: "unit-test-token",
			fileName: "sozluk@desktop.png",
		}).pipe(Effect.provide(layer)),
	);

describe("uploadAsset — over a stubbed transport (never fails the effect)", () => {
	it("returns the hosted URL on a 201 with a valid href", async () => {
		const o = await runUpload(stubResponse(201, JSON.stringify({href: HOSTED})));
		assert.strictEqual(o.hostedUrl, HOSTED);
		assert.strictEqual(o.uploadError, null);
	});

	it("degrades to uploadError on a 5xx, without failing the effect", async () => {
		const o = await runUpload(stubResponse(503, "unavailable"));
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /HTTP 503/);
	});

	it("degrades to uploadError on a transport failure (the endpoint is gone/unreachable)", async () => {
		const o = await runUpload(stubTransportError);
		assert.strictEqual(o.hostedUrl, null);
		assert.match(o.uploadError ?? "", /request failed/);
	});
});
