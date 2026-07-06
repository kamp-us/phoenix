/**
 * The upload-response parser (pure) and the `uploadAsset` Effect over a stubbed
 * transport (off-network, ADR 0082). These pin the FALLBACK contract — the
 * acceptance criterion that an upload failure degrades to a marked `unhosted`
 * evidence entry with a diagnostic, never a silent drop and never a broken gate
 * (the undocumented `uploads.github.com/user-attachments/assets` endpoint may
 * change without notice — ADR 0165).
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
		const e = parseUploadResponse("sozluk-home@desktop", {
			status: 201,
			body: JSON.stringify({href: HOSTED}),
		});
		assert.strictEqual(e._tag, "hosted");
		assert.strictEqual(e._tag === "hosted" ? e.hostedUrl : "", HOSTED);
	});

	it("also accepts a `url` field", () => {
		const e = parseUploadResponse("x", {status: 200, body: JSON.stringify({url: HOSTED})});
		assert.strictEqual(e._tag, "hosted");
	});

	it("falls back on a 4xx status with a diagnostic naming the code", () => {
		const e = parseUploadResponse("x", {status: 404, body: "Not Found"});
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /HTTP 404/);
	});

	it("falls back on a 5xx status", () => {
		const e = parseUploadResponse("x", {status: 500, body: "boom"});
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /HTTP 500/);
	});

	it("falls back on an unparseable body (undocumented endpoint drift)", () => {
		const e = parseUploadResponse("x", {status: 201, body: "<html>not json</html>"});
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /unparseable/);
	});

	it("falls back on a 2xx body with no hosted URL field", () => {
		const e = parseUploadResponse("x", {status: 201, body: JSON.stringify({id: 5, name: "x.png"})});
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /no hosted URL/);
	});

	it("falls back on a URL that is not a GitHub user-attachments asset (never embeds a bogus link)", () => {
		const e = parseUploadResponse("x", {
			status: 201,
			body: JSON.stringify({href: "https://evil.example/x"}),
		});
		assert.strictEqual(e._tag, "unhosted");
	});

	it("carries the shot label through to the evidence", () => {
		const e = parseUploadResponse("pano-feed@mobile", {status: 500, body: "x"});
		assert.strictEqual(e.label, "pano-feed@mobile");
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
			label: "sozluk-home@desktop",
			pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			repositoryId: 1234177275,
			token: "unit-test-token",
			fileName: "sozluk-home@desktop.png",
		}).pipe(Effect.provide(layer)),
	);

describe("uploadAsset — over a stubbed transport (never fails the effect)", () => {
	it("returns hosted evidence on a 201 with a valid href", async () => {
		const e = await runUpload(stubResponse(201, JSON.stringify({href: HOSTED})));
		assert.strictEqual(e._tag, "hosted");
		assert.strictEqual(e._tag === "hosted" ? e.hostedUrl : "", HOSTED);
	});

	it("degrades to unhosted on a 5xx, without failing the effect", async () => {
		const e = await runUpload(stubResponse(503, "unavailable"));
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /HTTP 503/);
	});

	it("degrades to unhosted on a transport failure (the endpoint is gone/unreachable)", async () => {
		const e = await runUpload(stubTransportError);
		assert.strictEqual(e._tag, "unhosted");
		assert.match(e._tag === "unhosted" ? e.diagnostic : "", /request failed/);
	});
});
