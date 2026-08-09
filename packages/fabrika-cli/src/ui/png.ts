/**
 * The PNG decoder the `ui` group validates and diffs with — `node:zlib` and nothing else.
 *
 * A capture nobody can open is not evidence (#3925's class), so "is this PNG valid?" has to be
 * answered by actually decoding it: zero bytes, a truncated stream, a corrupt IDAT and a zero-area
 * image are all facts a header sniff would miss. The decoder is deliberately dependency-free —
 * fabrika is a published package an adopter installs, and a codec dependency for a few hundred lines
 * of spec-defined unfiltering buys nothing.
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

const invalid = (detail: string): PngRead => ({_tag: "Invalid", detail});

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
	if (raw.length < height * (stride + 1)) return "the pixel stream is truncated";
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
	const idat: Buffer[] = [];
	while (offset + 8 <= buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const start = offset + 8;
		if (start + length > buf.length) return invalid(`the ${type} chunk is truncated`);
		const data = buf.subarray(start, start + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8] as number;
			colorType = data[9] as number;
			interlace = data[12] as number;
		} else if (type === "PLTE") palette = Buffer.from(data);
		else if (type === "tRNS") transparency = Buffer.from(data);
		else if (type === "IDAT") idat.push(Buffer.from(data));
		else if (type === "IEND") break;
		offset = start + length + 4;
	}
	if (colorType === -1) return invalid("the stream carries no IHDR chunk");
	if (width === 0 || height === 0) return invalid(`zero area (${width}x${height})`);
	if (bitDepth !== 8)
		return invalid(`unsupported bit depth ${bitDepth} — only 8-bit is decodable here`);
	if (interlace !== 0) return invalid("interlaced PNGs are not decodable here");
	if (CHANNELS[colorType] === undefined) return invalid(`unsupported colour type ${colorType}`);
	if (idat.length === 0) return invalid("the stream carries no IDAT chunk");

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
