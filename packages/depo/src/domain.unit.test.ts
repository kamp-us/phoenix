/**
 * Unit tests for depo's client-side domain — content-type resolution and the `<sha256>.<ext>`
 * content address. The digest is asserted against a known-answer SHA-256 vector, so the key the
 * client computes is provably the key the doorman stores.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {contentAddressKey, contentTypeForFile, publicUrl, sha256Hex} from "./domain.ts";

describe("contentTypeForFile", () => {
	it.effect("resolves each allowlisted extension", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* contentTypeForFile("a.png"), "image/png");
			assert.strictEqual(yield* contentTypeForFile("a.jpg"), "image/jpeg");
			assert.strictEqual(yield* contentTypeForFile("a.jpeg"), "image/jpeg");
			assert.strictEqual(yield* contentTypeForFile("a.webp"), "image/webp");
		}),
	);

	it.effect("is case-insensitive on the extension", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* contentTypeForFile("SHOT.PNG"), "image/png");
			assert.strictEqual(yield* contentTypeForFile("photo.JPEG"), "image/jpeg");
		}),
	);

	it.effect("refuses a non-image extension", () =>
		Effect.gen(function* () {
			assert.isTrue(Exit.isFailure(yield* Effect.exit(contentTypeForFile("a.svg"))));
			assert.isTrue(Exit.isFailure(yield* Effect.exit(contentTypeForFile("a.gif"))));
			assert.isTrue(Exit.isFailure(yield* Effect.exit(contentTypeForFile("a.txt"))));
		}),
	);

	it.effect("refuses a name with no extension", () =>
		Effect.gen(function* () {
			assert.isTrue(Exit.isFailure(yield* Effect.exit(contentTypeForFile("README"))));
		}),
	);
});

describe("sha256Hex (known-answer vector)", () => {
	it.effect("hashes the empty input to the canonical digest", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				yield* sha256Hex(new Uint8Array(0)),
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);
		}),
	);
});

describe("contentAddressKey", () => {
	it.effect("is `<sha256>.<ext>` for the resolved type", () =>
		Effect.gen(function* () {
			const key = yield* contentAddressKey(new TextEncoder().encode("abc"), "image/png");
			assert.strictEqual(
				key,
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.png",
			);
		}),
	);

	it.effect("keys each allowlisted type under the doorman's extension", () =>
		Effect.gen(function* () {
			const bytes = new TextEncoder().encode("abc");
			const exts: Array<string | undefined> = [];
			for (const type of ["image/png", "image/jpeg", "image/webp"] as const) {
				exts.push((yield* contentAddressKey(bytes, type)).split(".")[1]);
			}
			assert.deepStrictEqual(exts, ["png", "jpg", "webp"]);
		}),
	);
});

describe("publicUrl", () => {
	it("prefixes the key with the depo read host", () => {
		assert.strictEqual(publicUrl("deadbeef.png"), "https://depo.kamp.us/deadbeef.png");
	});
});
