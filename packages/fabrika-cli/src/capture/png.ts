/**
 * Capture validation: whether a PNG a render produced is a record at all.
 *
 * A capture nobody can open is not evidence (#3925's class), so the check is on the bytes rather
 * than on the render's exit status: zero bytes, an undecodable header, and a zero-area image are
 * three ways a "successful" screenshot arrives empty, and all three used to reach a gate as pixels.
 *
 * PURE and header-only — no codec. The IHDR chunk sits at a fixed offset in every PNG, so the
 * dimensions are readable without decoding the image, which is what keeps this unit-tested and
 * dependency-free.
 */

/** The eight-byte PNG signature every conforming file opens with. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Signature (8) + length (4) + `IHDR` (4) + width (4) + height (4). */
const HEADER_BYTES = 24;

export interface PngHeader {
	readonly width: number;
	readonly height: number;
}

const readUint32 = (bytes: Uint8Array, offset: number): number =>
	((bytes[offset] ?? 0) << 24) |
	((bytes[offset + 1] ?? 0) << 16) |
	((bytes[offset + 2] ?? 0) << 8) |
	(bytes[offset + 3] ?? 0);

/** The image's declared dimensions, or `null` when the bytes are not a decodable PNG header. */
export const decodePngHeader = (bytes: Uint8Array): PngHeader | null => {
	if (bytes.length < HEADER_BYTES) return null;
	if (SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
	const chunkType = String.fromCharCode(...bytes.slice(12, 16));
	if (chunkType !== "IHDR") return null;
	return {width: readUint32(bytes, 16) >>> 0, height: readUint32(bytes, 20) >>> 0};
};

/** A capture is a record, or it is one of the three named ways it is not. */
export type CaptureValidity =
	| {readonly _tag: "Valid"; readonly width: number; readonly height: number}
	| {readonly _tag: "Invalid"; readonly reason: string};

/** Validate captured bytes: non-empty, decodable, non-zero area. */
export const validateCaptureBytes = (bytes: Uint8Array): CaptureValidity => {
	if (bytes.length === 0) return {_tag: "Invalid", reason: "zero bytes"};
	const header = decodePngHeader(bytes);
	if (header === null) return {_tag: "Invalid", reason: "undecodable — not a PNG header"};
	if (header.width === 0 || header.height === 0) {
		return {_tag: "Invalid", reason: `zero area (${header.width}x${header.height})`};
	}
	return {_tag: "Valid", width: header.width, height: header.height};
};
