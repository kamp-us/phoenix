/**
 * Unit tests for the doorman's pure domain (`domain.ts`) — the allowlist, the size
 * cap, and content-address key derivation. No engine, no I/O
 * (`.patterns/effect-testing.md` unit tier): these rules could be wrong even if R2
 * and D1 behaved perfectly, so they belong here.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	ALLOWED_TYPES,
	allowedContentType,
	contentAddressKey,
	publicUrl,
	SIZE_CAP_BYTES,
	sha256Hex,
	withinSizeCap,
} from "./domain.ts";

describe("allowedContentType", () => {
	it.effect("accepts each allowlisted type", () =>
		Effect.gen(function* () {
			for (const type of Object.keys(ALLOWED_TYPES)) {
				assert.strictEqual(yield* allowedContentType(type), type);
			}
		}),
	);

	it.effect("normalizes casing and strips parameters", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* allowedContentType("IMAGE/PNG"), "image/png");
			assert.strictEqual(yield* allowedContentType("image/jpeg; charset=binary"), "image/jpeg");
		}),
	);

	it.effect("refuses a non-allowlisted type", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(allowedContentType("image/svg+xml"));
			assert.isTrue(Exit.isFailure(exit));
		}),
	);

	it.effect("refuses a missing content-type", () =>
		Effect.gen(function* () {
			assert.isTrue(Exit.isFailure(yield* Effect.exit(allowedContentType(null))));
			assert.isTrue(Exit.isFailure(yield* Effect.exit(allowedContentType(undefined))));
			assert.isTrue(Exit.isFailure(yield* Effect.exit(allowedContentType(""))));
		}),
	);
});

describe("withinSizeCap", () => {
	it.effect("passes a body at or under the cap", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* withinSizeCap(0), 0);
			assert.strictEqual(yield* withinSizeCap(SIZE_CAP_BYTES), SIZE_CAP_BYTES);
		}),
	);

	it.effect("refuses a body one byte over the cap", () =>
		Effect.gen(function* () {
			assert.isTrue(Exit.isFailure(yield* Effect.exit(withinSizeCap(SIZE_CAP_BYTES + 1))));
		}),
	);
});

describe("content addressing", () => {
	// SHA-256 of the empty input, hex — a fixed, verifiable vector.
	const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

	it.effect("sha256Hex matches the known empty-input vector", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* sha256Hex(new Uint8Array()), EMPTY_SHA256);
		}),
	);

	it.effect("the key is <sha256>.<ext> for the type", () =>
		Effect.gen(function* () {
			const key = yield* contentAddressKey(new Uint8Array(), "image/png");
			assert.strictEqual(key, `${EMPTY_SHA256}.png`);
			const jpg = yield* contentAddressKey(new Uint8Array(), "image/jpeg");
			assert.strictEqual(jpg, `${EMPTY_SHA256}.jpg`);
		}),
	);

	it.effect("identical bytes derive the identical key (content-addressed)", () =>
		Effect.gen(function* () {
			const bytes = new Uint8Array([1, 2, 3, 4]);
			const a = yield* contentAddressKey(bytes, "image/webp");
			const b = yield* contentAddressKey(new Uint8Array([1, 2, 3, 4]), "image/webp");
			assert.strictEqual(a, b);
		}),
	);

	it("publicUrl embeds the key under depo.kamp.us", () => {
		assert.strictEqual(publicUrl("abc.png"), "https://depo.kamp.us/abc.png");
	});
});
