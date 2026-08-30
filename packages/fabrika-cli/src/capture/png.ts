/**
 * Capture validation delegates to the governed PNG decoder used by the `ui` group.
 *
 * A capture nobody can open is not evidence (#3925's class). Signature/header checks cannot prove a
 * complete image: every chunk CRC, the compressed pixel stream, the terminal IEND chunk and the
 * absence of trailing/truncated bytes must all survive the same decoder that reads UI evidence.
 */
import {decodePng} from "../ui/png.ts";

export interface PngHeader {
	readonly width: number;
	readonly height: number;
}

/** The dimensions of a complete decodable PNG, or `null` when any byte-level proof fails. */
export const decodePngHeader = (bytes: Uint8Array): PngHeader | null => {
	const decoded = decodePng(bytes);
	return decoded._tag === "Image"
		? {width: decoded.image.width, height: decoded.image.height}
		: null;
};

/** A capture is a record, or it carries the decoder's concrete refusal. */
export type CaptureValidity =
	| {readonly _tag: "Valid"; readonly width: number; readonly height: number}
	| {readonly _tag: "Invalid"; readonly reason: string};

/** Validate captured bytes through complete PNG chunk, CRC, inflate and raster decoding. */
export const validateCaptureBytes = (bytes: Uint8Array): CaptureValidity => {
	const decoded = decodePng(bytes);
	return decoded._tag === "Image"
		? {_tag: "Valid", width: decoded.image.width, height: decoded.image.height}
		: {_tag: "Invalid", reason: decoded.detail};
};
