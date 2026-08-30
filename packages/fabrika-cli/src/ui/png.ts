/**
 * The PNG decoder the `ui` group validates and diffs with — `node:zlib` and nothing else.
 *
 * A capture nobody can open is not evidence (#3925's class), so "is this PNG valid?" has to be
 * answered by actually decoding it: zero bytes, a truncated stream, a corrupt chunk/IDAT and a
 * zero-area image are all facts a header sniff would miss. The decoder is deliberately
 * dependency-free — fabrika is a published package an adopter installs, and a codec dependency for
 * a few hundred lines of spec-defined parsing and unfiltering buys nothing.
 *
 * The supported subset is 8-bit, non-interlaced, colour types 0/2/3/4/6 — what every headless-browser
 * screenshot emits. Anything else decodes to an {@link Invalid} with the encoding named, never to a
 * silently wrong raster.
 */
import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";

/** A decoded image: `pixels` is RGBA, row-major, length exactly `width * height * 4`. */
export interface RasterImage {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
}

export type PngRead =
	| {readonly _tag: "Image"; readonly image: RasterImage}
	/** Proven invalid: the bytes are not a decodable, non-zero-area PNG. `detail` names why. */
	| {readonly _tag: "Invalid"; readonly detail: string};

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Readonly<Record<number, number>> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const CHUNK_TYPE = /^[A-Za-z]{4}$/;

const invalid = (detail: string): PngRead => ({_tag: "Invalid", detail});

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

const crc32 = (bytes: Uint8Array): number => {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

const paeth = (a: number, b: number, c: number): number => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
};

/** Reverse the per-scanline filters in place, yielding raw samples row-major. */
const unfilter = (raw: Buffer, width: number, height: number, bpp: number): Buffer | string => {
	const stride = width * bpp;
	const expected = height * (stride + 1);
	if (raw.length !== expected) {
		return raw.length < expected
			? "the pixel stream is truncated"
			: "the pixel stream has trailing decoded bytes";
	}
	const out = Buffer.alloc(height * stride);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++] as number;
		const rowStart = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[pos + x] as number;
			const left = x >= bpp ? (out[rowStart + x - bpp] as number) : 0;
			const up = y > 0 ? (out[rowStart - stride + x] as number) : 0;
			const upLeft = y > 0 && x >= bpp ? (out[rowStart - stride + x - bpp] as number) : 0;
			let restored: number;
			switch (filter) {
				case 0:
					restored = value;
					break;
				case 1:
					restored = value + left;
					break;
				case 2:
					restored = value + up;
					break;
				case 3:
					restored = value + ((left + up) >> 1);
					break;
				case 4:
					restored = value + paeth(left, up, upLeft);
					break;
				default:
					return `scanline ${y} carries an unknown filter type ${filter}`;
			}
			out[rowStart + x] = restored & 0xff;
		}
		pos += stride;
	}
	return out;
};

const toRgba = (
	samples: Buffer,
	width: number,
	height: number,
	colorType: number,
	palette: Buffer | null,
	transparency: Buffer | null,
): Uint8Array | string => {
	const channels = CHANNELS[colorType] as number;
	const pixels = new Uint8Array(width * height * 4);
	for (let p = 0; p < width * height; p++) {
		const src = p * channels;
		const dst = p * 4;
		if (colorType === 3) {
			const index = samples[src] as number;
			if (palette === null || index * 3 + 2 >= palette.length) {
				return `a palette index (${index}) falls outside the PLTE chunk`;
			}
			pixels[dst] = palette[index * 3] as number;
			pixels[dst + 1] = palette[index * 3 + 1] as number;
			pixels[dst + 2] = palette[index * 3 + 2] as number;
			pixels[dst + 3] =
				transparency !== null && index < transparency.length
					? (transparency[index] as number)
					: 255;
			continue;
		}
		const gray = colorType === 0 || colorType === 4;
		pixels[dst] = samples[src] as number;
		pixels[dst + 1] = gray ? (samples[src] as number) : (samples[src + 1] as number);
		pixels[dst + 2] = gray ? (samples[src] as number) : (samples[src + 2] as number);
		pixels[dst + 3] =
			colorType === 6
				? (samples[src + 3] as number)
				: colorType === 4
					? (samples[src + 1] as number)
					: 255;
	}
	return pixels;
};

/** Decode PNG bytes into an RGBA raster, or say — in one sentence — why they are not one. */
export const decodePng = (bytes: Uint8Array): PngRead => {
	if (bytes.length === 0) return invalid("zero bytes");
	if (bytes.length < 8 || SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
		return invalid("the bytes do not carry a PNG signature");
	}
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let bitDepth = 0;
	let interlace = 0;
	let palette: Buffer | null = null;
	let transparency: Buffer | null = null;
	let sawIhdr = false;
	let sawIend = false;
	let sawIdat = false;
	let idatClosed = false;
	const idat: Buffer[] = [];
	while (offset < buf.length) {
		if (buf.length - offset < 12) return invalid("the final PNG chunk is truncated");
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		if (!CHUNK_TYPE.test(type)) return invalid("the stream carries an invalid chunk type");
		const start = offset + 8;
		const end = start + length;
		if (end + 4 > buf.length) return invalid(`the ${type} chunk is truncated`);
		const expectedCrc = buf.readUInt32BE(end);
		const actualCrc = crc32(buf.subarray(offset + 4, end));
		if (expectedCrc !== actualCrc) return invalid(`the ${type} chunk CRC does not match`);
		const data = buf.subarray(start, end);

		if (!sawIhdr && type !== "IHDR") return invalid("IHDR is not the first chunk");
		if (sawIdat && type !== "IDAT") idatClosed = true;
		if (type === "IHDR") {
			if (sawIhdr) return invalid("the stream carries more than one IHDR chunk");
			if (length !== 13) return invalid("the IHDR chunk is not 13 bytes");
			sawIhdr = true;
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8] as number;
			colorType = data[9] as number;
			if (data[10] !== 0 || data[11] !== 0) {
				return invalid("the IHDR chunk names an unsupported compression or filter method");
			}
			interlace = data[12] as number;
		} else if (type === "PLTE") {
			if (palette !== null || sawIdat)
				return invalid("the PLTE chunk is duplicated or out of order");
			palette = Buffer.from(data);
		} else if (type === "tRNS") {
			if (transparency !== null || sawIdat) {
				return invalid("the tRNS chunk is duplicated or out of order");
			}
			transparency = Buffer.from(data);
		} else if (type === "IDAT") {
			if (idatClosed) return invalid("the IDAT chunks are not consecutive");
			sawIdat = true;
			idat.push(Buffer.from(data));
		} else if (type === "IEND") {
			if (length !== 0) return invalid("the IEND chunk is not empty");
			if (!sawIdat) return invalid("IEND appears before any IDAT chunk");
			sawIend = true;
			offset = end + 4;
			break;
		} else if ((type.charCodeAt(0) & 0x20) === 0) {
			return invalid(`the stream carries unsupported critical chunk ${type}`);
		}
		offset = end + 4;
	}
	if (!sawIhdr) return invalid("the stream carries no IHDR chunk");
	if (!sawIend) return invalid("the stream carries no complete IEND chunk");
	if (offset !== buf.length) return invalid("the stream has bytes after IEND");
	if (width === 0 || height === 0) return invalid(`zero area (${width}x${height})`);
	if (bitDepth !== 8)
		return invalid(`unsupported bit depth ${bitDepth} — only 8-bit is decodable here`);
	if (interlace !== 0) return invalid("interlaced PNGs are not decodable here");
	if (CHANNELS[colorType] === undefined) return invalid(`unsupported colour type ${colorType}`);
	if (colorType === 3 && palette === null) return invalid("indexed colour carries no PLTE chunk");

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch (err) {
		return invalid(`the pixel stream does not inflate (${(err as Error).message})`);
	}
	const samples = unfilter(raw, width, height, CHANNELS[colorType] as number);
	if (typeof samples === "string") return invalid(samples);
	const pixels = toRgba(samples, width, height, colorType, palette, transparency);
	if (typeof pixels === "string") return invalid(pixels);
	return {_tag: "Image", image: {width, height, pixels}};
};

/** The lowercase-hex sha256 of some bytes — the content address every capture is named by. */
export const sha256Of = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");
