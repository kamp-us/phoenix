/**
 * Unit tests for the upload orchestrator (`upload.ts`) — the whole write path with
 * both seams substituted (no live D1 / R2), per `.patterns/effect-testing.md`. This
 * is where the issue's acceptance rules are proven at the unit tier: the auth gate,
 * the allowlist + size cap ordering, and write-once (idempotent re-PUT vs refusing a
 * differing body under an existing key).
 *
 * The `Storage` double is an in-memory map recording puts, so a "no write" claim is
 * provable (a refused upload leaves the map empty); the `ApiKeyVerifier` double is
 * scripted to accept or reject.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {SIZE_CAP_BYTES} from "./domain.ts";
import {Unauthorized} from "./errors.ts";
import {Storage, type StoredObject} from "./storage.ts";
import {type UploadRequest, upload} from "./upload.ts";
import {ApiKeyVerifier} from "./verifier.ts";

/** A recording in-memory storage double: `put`s land in `store`; `head` reads it. */
const makeStorageDouble = (store: Map<string, StoredObject>) =>
	Layer.succeed(Storage)(
		Storage.of({
			head: (key) => Effect.succeed(store.get(key) ?? null),
			put: (key, bytes) =>
				Effect.sync(() => {
					store.set(key, {size: bytes.byteLength});
				}),
		}),
	);

/** A verifier double: accepts any non-null key as `user-1`, rejects null. */
const acceptingVerifier = Layer.succeed(ApiKeyVerifier)(
	ApiKeyVerifier.of({
		verify: (key) =>
			key === null
				? Effect.fail(new Unauthorized({reason: "missing"}))
				: Effect.succeed({userId: "user-1"}),
	}),
);

/** A verifier double that rejects everything. */
const rejectingVerifier = Layer.succeed(ApiKeyVerifier)(
	ApiKeyVerifier.of({
		verify: () => Effect.fail(new Unauthorized({reason: "invalid"})),
	}),
);

const pngBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const req = (over: Partial<UploadRequest> = {}): UploadRequest => ({
	apiKey: "valid-key",
	contentType: "image/png",
	body: pngBody,
	...over,
});

describe("upload — auth gate", () => {
	it.effect("refuses and stores nothing when the key is invalid", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const exit = yield* upload(req()).pipe(
				Effect.provide(Layer.mergeAll(makeStorageDouble(store), rejectingVerifier)),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.strictEqual(store.size, 0, "a rejected upload must write nothing");
		}),
	);

	it.effect("refuses a missing key", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const exit = yield* upload(req({apiKey: null})).pipe(
				Effect.provide(Layer.mergeAll(makeStorageDouble(store), acceptingVerifier)),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.strictEqual(store.size, 0);
		}),
	);
});

describe("upload — guards", () => {
	it.effect("refuses a non-allowlisted content-type and stores nothing", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const exit = yield* upload(req({contentType: "application/pdf"})).pipe(
				Effect.provide(Layer.mergeAll(makeStorageDouble(store), acceptingVerifier)),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.strictEqual(store.size, 0);
		}),
	);

	it.effect("refuses an over-cap body and stores nothing", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const big = new Uint8Array(SIZE_CAP_BYTES + 1);
			const exit = yield* upload(req({body: big})).pipe(
				Effect.provide(Layer.mergeAll(makeStorageDouble(store), acceptingVerifier)),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			assert.strictEqual(store.size, 0);
		}),
	);
});

describe("upload — happy path + write-once", () => {
	it.effect("stores a valid upload at <sha256>.<ext> and returns the URL", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const result = yield* upload(req()).pipe(
				Effect.provide(Layer.mergeAll(makeStorageDouble(store), acceptingVerifier)),
			);
			assert.isTrue(result.created);
			assert.match(result.key, /^[0-9a-f]{64}\.png$/);
			assert.strictEqual(result.url, `https://depo.kamp.us/${result.key}`);
			assert.isTrue(store.has(result.key));
		}),
	);

	it.effect("a byte-identical re-PUT is a benign idempotent success (created:false)", () =>
		Effect.gen(function* () {
			const store = new Map<string, StoredObject>();
			const layers = Layer.mergeAll(makeStorageDouble(store), acceptingVerifier);
			const first = yield* upload(req()).pipe(Effect.provide(layers));
			const second = yield* upload(req()).pipe(Effect.provide(layers));
			assert.isTrue(first.created);
			assert.isFalse(second.created);
			assert.strictEqual(first.key, second.key);
			assert.strictEqual(store.size, 1, "no second object is written");
		}),
	);

	it.effect("refuses a differing body under an existing content-address (write-once)", () =>
		Effect.gen(function* () {
			// Seed the store with a same-key object of a DIFFERENT size, simulating a
			// sha256 collision: the orchestrator must refuse rather than overwrite.
			const store = new Map<string, StoredObject>();
			const layers = Layer.mergeAll(makeStorageDouble(store), acceptingVerifier);
			const first = yield* upload(req()).pipe(Effect.provide(layers));
			store.set(first.key, {size: first.key.length + 999});
			const exit = yield* upload(req()).pipe(Effect.provide(layers), Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
		}),
	);
});
