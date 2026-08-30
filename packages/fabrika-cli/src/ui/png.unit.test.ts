import {describe, expect, it} from "vitest";
import {encodePng, solid} from "./fakes.test-support.ts";
import {decodePng, sha256Of} from "./png.ts";

describe("decodePng", () => {
	it("round-trips an RGBA raster through a real PNG", () => {
		const pixels = solid(3, 2, [10, 20, 30, 255]);
		const decoded = decodePng(encodePng(3, 2, pixels));
		expect(decoded._tag).toBe("Image");
		if (decoded._tag !== "Image") return;
		expect(decoded.image.width).toBe(3);
		expect(decoded.image.height).toBe(2);
		expect([...decoded.image.pixels]).toEqual([...pixels]);
	});

	it.each([
		["zero bytes", new Uint8Array(0), "zero bytes"],
		[
			"a non-PNG file",
			new TextEncoder().encode("not a png at all"),
			"the bytes do not carry a PNG signature",
		],
	])("calls %s invalid, naming why", (_label, bytes, detail) => {
		expect(decodePng(bytes)).toEqual({_tag: "Invalid", detail});
	});

	it("refuses chunk truncation, CRC corruption, missing IEND, and trailing bytes", () => {
		const png = encodePng(4, 4, solid(4, 4, [0, 0, 0, 255]));
		expect(decodePng(png.subarray(0, png.length - 20))).toMatchObject({_tag: "Invalid"});
		expect(decodePng(png.subarray(0, png.length - 12))).toEqual({
			_tag: "Invalid",
			detail: "the stream carries no complete IEND chunk",
		});

		const corrupt = png.slice();
		corrupt[29] = (corrupt[29] ?? 0) ^ 0xff;
		expect(decodePng(corrupt)).toEqual({
			_tag: "Invalid",
			detail: "the IHDR chunk CRC does not match",
		});

		const trailing = new Uint8Array(png.length + 1);
		trailing.set(png);
		expect(decodePng(trailing)).toEqual({
			_tag: "Invalid",
			detail: "the stream has bytes after IEND",
		});
	});
});

describe("sha256Of", () => {
	it("is the content address the pointer and the set manifest both key on", () => {
		expect(sha256Of(new TextEncoder().encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});
