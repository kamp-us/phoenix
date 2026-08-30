import {assert, describe, it} from "@effect/vitest";
import {encodePng, solid} from "../ui/fakes.test-support.ts";
import {decodePngHeader, validateCaptureBytes} from "./png.ts";

const png = (width: number, height: number): Uint8Array =>
	encodePng(width, height, solid(width, height, [10, 20, 30, 255]));

describe("decodePngHeader", () => {
	it("reads dimensions only from a complete decodable PNG", () => {
		assert.deepStrictEqual(decodePngHeader(png(1280, 800)), {width: 1280, height: 800});
	});

	it("returns null for bytes that are not a complete PNG", () => {
		assert.strictEqual(decodePngHeader(new Uint8Array(0)), null);
		assert.strictEqual(decodePngHeader(new TextEncoder().encode("not a png at all")), null);
		assert.strictEqual(decodePngHeader(png(8, 4).subarray(0, 24)), null);
	});
});

describe("validateCaptureBytes", () => {
	it("accepts a complete decodable, non-zero-area capture", () => {
		assert.deepStrictEqual(validateCaptureBytes(png(1280, 800)), {
			_tag: "Valid",
			width: 1280,
			height: 800,
		});
	});

	it("refuses malformed, truncated, CRC-corrupt, and unterminated captures", () => {
		assert.deepStrictEqual(validateCaptureBytes(new Uint8Array(0)), {
			_tag: "Invalid",
			reason: "zero bytes",
		});
		assert.strictEqual(validateCaptureBytes(new Uint8Array(30))._tag, "Invalid");

		const complete = png(8, 4);
		assert.match(
			validateCaptureBytes(complete.subarray(0, 24))._tag === "Invalid"
				? (validateCaptureBytes(complete.subarray(0, 24)) as {reason: string}).reason
				: "",
			/truncated/,
		);

		const badCrc = complete.slice();
		badCrc[29] = (badCrc[29] ?? 0) ^ 0xff;
		const crcResult = validateCaptureBytes(badCrc);
		assert.match(crcResult._tag === "Invalid" ? crcResult.reason : "", /CRC/);

		const withoutIend = complete.subarray(0, complete.length - 12);
		const iendResult = validateCaptureBytes(withoutIend);
		assert.match(iendResult._tag === "Invalid" ? iendResult.reason : "", /IEND/);

		const trailing = new Uint8Array(complete.length + 1);
		trailing.set(complete);
		const trailingResult = validateCaptureBytes(trailing);
		assert.match(trailingResult._tag === "Invalid" ? trailingResult.reason : "", /after IEND/);
	});
});
