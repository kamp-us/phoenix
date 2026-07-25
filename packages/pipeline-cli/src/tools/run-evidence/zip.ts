/**
 * A minimal in-memory ZIP reader — enough to pull one named entry out of a downloaded GitHub
 * Actions artifact without shelling out to `unzip` and without landing a scratch file.
 *
 * Why the bytes never leave memory (#3991): the run-evidence lookup has to decide PRESENT vs
 * UNKNOWN *from the bytes it received*. Routing them through a temp file + `unzip` puts the
 * decisive validation behind a subprocess, where a 503 error body written where an archive was
 * expected reads back as "no manifest" — indistinguishable from a bundle that was never
 * published. Keeping `hasZipMagic` and the directory walk pure makes "this is not an archive"
 * positive, unit-testable evidence for UNKNOWN instead of an absence inferred from a missing file.
 *
 * Reads the CENTRAL directory rather than the local headers on purpose: a streamed ZIP writes
 * zeroed sizes into the local header and defers them to a trailing data descriptor, so the local
 * header alone cannot bound an entry's compressed bytes.
 */
import {inflateRawSync} from "node:zlib";

/** The ZIP local-file-header magic, hex — what proves a download is an archive and not an error body. */
export const ZIP_MAGIC = "504b0304";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_HEADER_FIXED_SIZE = 46;
const LOCAL_HEADER_FIXED_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

const decoder = new TextDecoder();

/** The first four bytes as lowercase hex — the observed magic, for a legible UNKNOWN reason. */
export const magicOf = (bytes: Uint8Array): string =>
	[...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Does this payload open with the ZIP local-file-header magic (`PK\x03\x04`)? */
export const hasZipMagic = (bytes: Uint8Array): boolean =>
	bytes.length >= 4 &&
	bytes[0] === 0x50 &&
	bytes[1] === 0x4b &&
	bytes[2] === 0x03 &&
	bytes[3] === 0x04;

/**
 * Reading one entry has three outcomes, and they are not interchangeable: `Found` is the entry,
 * `NotFound` is a real archive that simply lacks it, `Malformed` is "these bytes are not a
 * readable archive" — the UNKNOWN seam.
 */
export type ZipEntryRead =
	| {readonly _tag: "Found"; readonly bytes: Uint8Array}
	| {readonly _tag: "NotFound"; readonly names: ReadonlyArray<string>}
	| {readonly _tag: "Malformed"; readonly reason: string};

const findEocd = (view: DataView): number => {
	const last = view.byteLength - EOCD_FIXED_SIZE;
	const first = Math.max(0, last - MAX_COMMENT_SIZE);
	for (let at = last; at >= first; at--) {
		if (view.getUint32(at, true) === EOCD_SIG) return at;
	}
	return -1;
};

const readEntryData = (
	bytes: Uint8Array,
	view: DataView,
	localOffset: number,
	method: number,
	compressedSize: number,
): ZipEntryRead => {
	if (
		localOffset + LOCAL_HEADER_FIXED_SIZE > view.byteLength ||
		view.getUint32(localOffset, true) !== LOCAL_HEADER_SIG
	) {
		return {
			_tag: "Malformed",
			reason: "no local file header at the offset the central directory names",
		};
	}
	const nameLength = view.getUint16(localOffset + 26, true);
	const extraLength = view.getUint16(localOffset + 28, true);
	const start = localOffset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength;
	const end = start + compressedSize;
	if (end > bytes.length) {
		return {_tag: "Malformed", reason: "entry data runs past the end of the archive (truncated)"};
	}
	const raw = bytes.subarray(start, end);
	if (method === METHOD_STORED) return {_tag: "Found", bytes: raw};
	if (method !== METHOD_DEFLATED) {
		return {_tag: "Malformed", reason: `unsupported compression method ${method}`};
	}
	try {
		return {_tag: "Found", bytes: new Uint8Array(inflateRawSync(raw))};
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		return {_tag: "Malformed", reason: `inflate failed: ${detail}`};
	}
};

/** Extract one entry by exact name from an in-memory ZIP archive. */
export const readZipEntry = (bytes: Uint8Array, name: string): ZipEntryRead => {
	if (!hasZipMagic(bytes)) {
		return {
			_tag: "Malformed",
			reason: `not a ZIP archive — ${bytes.length}-byte payload opening with magic ${magicOf(bytes) || "(empty)"}, expected ${ZIP_MAGIC}`,
		};
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = findEocd(view);
	if (eocd < 0) {
		return {_tag: "Malformed", reason: "no end-of-central-directory record (truncated archive)"};
	}
	const entryCount = view.getUint16(eocd + 10, true);
	let cursor = view.getUint32(eocd + 16, true);
	const names: Array<string> = [];
	for (let index = 0; index < entryCount; index++) {
		if (
			cursor + CENTRAL_HEADER_FIXED_SIZE > view.byteLength ||
			view.getUint32(cursor, true) !== CENTRAL_HEADER_SIG
		) {
			return {
				_tag: "Malformed",
				reason: `central directory entry ${index} is not where the record says it is`,
			};
		}
		const method = view.getUint16(cursor + 10, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const nameStart = cursor + CENTRAL_HEADER_FIXED_SIZE;
		const entryName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
		names.push(entryName);
		if (entryName === name) {
			return readEntryData(bytes, view, localOffset, method, compressedSize);
		}
		cursor = nameStart + nameLength + extraLength + commentLength;
	}
	return {_tag: "NotFound", names};
};
