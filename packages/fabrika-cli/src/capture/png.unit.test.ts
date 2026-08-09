import {assert, describe, it} from "@effect/vitest";
import {decodePngHeader, validateCaptureBytes} from "./png.ts";

/** A PNG signature + IHDR chunk at the declared dimensions — the only bytes the header reader needs. */
const png = (width: number, height: number): Uint8Array => {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
};

describe("decodePngHeader", () => {
	it("reads the declared dimensions out of the IHDR chunk", () => {
		assert.deepStrictEqual(decodePngHeader(png(1280, 2140)), {width: 1280, height: 2140});
	});

	it("returns null for bytes that are not a PNG header", () => {
		assert.strictEqual(decodePngHeader(new Uint8Array(0)), null);
		assert.strictEqual(decodePngHeader(new TextEncoder().encode("not a png at all!!!!!!!!")), null);
		const wrongChunk = png(10, 10);
		wrongChunk.set([0x49, 0x44, 0x41, 0x54], 12);
		assert.strictEqual(decodePngHeader(wrongChunk), null);
	});
});

describe("validateCaptureBytes", () => {
	it("accepts a decodable, non-zero-area capture", () => {
		assert.deepStrictEqual(validateCaptureBytes(png(1280, 800)), {
			_tag: "Valid",
			width: 1280,
			height: 800,
		});
	});

	it("names each of the three ways a capture is not evidence", () => {
		assert.deepStrictEqual(validateCaptureBytes(new Uint8Array(0)), {
			_tag: "Invalid",
			reason: "zero bytes",
		});
		assert.strictEqual(validateCaptureBytes(new Uint8Array(30))._tag, "Invalid");
		const zeroArea = validateCaptureBytes(png(1280, 0));
		assert.strictEqual(zeroArea._tag, "Invalid");
		assert.match(zeroArea._tag === "Invalid" ? zeroArea.reason : "", /zero area/);
	});
});
