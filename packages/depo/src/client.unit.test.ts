/**
 * Unit tests for the client core (`putBytes`) with the doorman behind the
 * `DoormanClient` seam — no live worker (`.patterns/effect-testing.md` unit tier).
 * These assert the acceptance contract: the content-addressed request the client
 * SENDS, and the mapping from each doorman status to a typed outcome (a case per
 * status below).
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {DoormanClient, type DoormanRequest, type DoormanResponse, putBytes} from "./client.ts";
import {contentAddressKey} from "./domain.ts";

const BYTES = new TextEncoder().encode("abc");
const KEY_ABC_PNG = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.png";
const URL_ABC_PNG = `https://depo.kamp.us/${KEY_ABC_PNG}`;

/**
 * A seam stub that records the request it was sent and replies with a canned
 * response — the substitution that lets the core run end to end with no HTTP.
 */
const stubClient = (
	response: DoormanResponse,
	recorder?: (req: DoormanRequest) => void,
): Layer.Layer<DoormanClient> =>
	Layer.succeed(DoormanClient)(
		DoormanClient.of({
			send: (req) =>
				Effect.sync(() => {
					recorder?.(req);
					return response;
				}),
		}),
	);

const putPng = (response: DoormanResponse, recorder?: (req: DoormanRequest) => void) =>
	putBytes({apiKey: "key-123", contentType: "image/png", body: BYTES}).pipe(
		Effect.provide(stubClient(response, recorder)),
	);

describe("putBytes — the request it sends", () => {
	it.effect("presents the apiKey, content-type, and raw body", () =>
		Effect.gen(function* () {
			let sent: DoormanRequest | undefined;
			yield* putPng(
				{status: 201, body: JSON.stringify({key: KEY_ABC_PNG, url: URL_ABC_PNG})},
				(r) => {
					sent = r;
				},
			);
			assert.strictEqual(sent?.apiKey, "key-123");
			assert.strictEqual(sent?.contentType, "image/png");
			assert.deepStrictEqual(sent?.body, BYTES);
		}),
	);
});

describe("putBytes — status → outcome mapping", () => {
	it.effect("201 (created) → returns the doorman's public URL", () =>
		Effect.gen(function* () {
			const url = yield* putPng({
				status: 201,
				body: JSON.stringify({key: KEY_ABC_PNG, url: URL_ABC_PNG}),
			});
			assert.strictEqual(url, URL_ABC_PNG);
		}),
	);

	it.effect("200 (idempotent re-PUT) → also returns the public URL", () =>
		Effect.gen(function* () {
			const url = yield* putPng({
				status: 200,
				body: JSON.stringify({key: KEY_ABC_PNG, url: URL_ABC_PNG}),
			});
			assert.strictEqual(url, URL_ABC_PNG);
		}),
	);

	it.effect("2xx with no/blank body → re-derives the URL from the content address", () =>
		Effect.gen(function* () {
			const expected = yield* contentAddressKey(BYTES, "image/png");
			const url = yield* putPng({status: 201, body: ""});
			assert.strictEqual(url, `https://depo.kamp.us/${expected}`);
		}),
	);

	it.effect("401 → Unauthorized", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(putPng({status: 401, body: "unauthorized"}));
			assert.isTrue(Exit.isFailure(exit));
			const err = yield* putPng({status: 401, body: "unauthorized"}).pipe(Effect.flip);
			assert.strictEqual(err._tag, "depo/Unauthorized");
		}),
	);

	it.effect("415 → UnsupportedMediaType", () =>
		Effect.gen(function* () {
			const err = yield* putPng({status: 415, body: "unsupported media type"}).pipe(Effect.flip);
			assert.strictEqual(err._tag, "depo/UnsupportedMediaType");
		}),
	);

	it.effect("413 → PayloadTooLarge", () =>
		Effect.gen(function* () {
			const err = yield* putPng({status: 413, body: "payload too large"}).pipe(Effect.flip);
			assert.strictEqual(err._tag, "depo/PayloadTooLarge");
		}),
	);

	it.effect("409 → ContentAddressConflict", () =>
		Effect.gen(function* () {
			const err = yield* putPng({status: 409, body: "content-address conflict"}).pipe(Effect.flip);
			assert.strictEqual(err._tag, "depo/ContentAddressConflict");
		}),
	);

	it.effect("500 (or any unmapped status) → UploadFailed carrying the status", () =>
		Effect.gen(function* () {
			const err = yield* putPng({status: 500, body: "internal error"}).pipe(Effect.flip);
			assert.strictEqual(err._tag, "depo/UploadFailed");
			assert.strictEqual((err as {status: number | null}).status, 500);
		}),
	);
});
