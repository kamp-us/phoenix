/**
 * The `ui` group's two test seams: a **byte-capable** filesystem layer, and a PNG encoder.
 *
 * `../fakes.test-support.ts` speaks UTF-8 (`readFileString`/`writeFileString`), which the shipped
 * groups only ever needed; every artifact here is a PNG, so the fake has to answer `readFile` and
 * `writeFile` too. The encoder exists so a capture fixture is a *real* PNG the production decoder
 * reads — a hand-written byte blob would only prove the decoder agrees with the fixture's author.
 */
import {deflateSync} from "node:zlib";
import {Effect, FileSystem, Layer, Path, PlatformError} from "effect";

const notFound = (method: string, path: string) =>
	Effect.fail(
		PlatformError.systemError({
			_tag: "NotFound",
			module: "FileSystem",
			method,
			pathOrDescriptor: path,
		}),
	);

export interface FakeBytesFsOptions {
	/** Path → contents. A `null` entry exists as a path that cannot be read. */
	readonly files?: Readonly<Record<string, Uint8Array | string | null>>;
	/** Paths whose existence check itself fails — distinct from a path that is absent. */
	readonly unprobeable?: ReadonlyArray<string>;
	/** Paths whose writes fail. */
	readonly unwritable?: ReadonlyArray<string>;
}

export interface FakeBytesFs {
	readonly layer: Layer.Layer<FileSystem.FileSystem | Path.Path>;
	readonly written: Map<string, Uint8Array>;
}

const asBytes = (value: Uint8Array | string): Uint8Array =>
	typeof value === "string" ? new TextEncoder().encode(value) : value;

export const fakeBytesFs = (options: FakeBytesFsOptions = {}): FakeBytesFs => {
	const files: Record<string, Uint8Array | string | null> = {...options.files};
	const written = new Map<string, Uint8Array>();
	const read = (method: string, path: string) => {
		const value = files[path];
		return value === undefined || value === null
			? notFound(method, path)
			: Effect.succeed(asBytes(value));
	};
	const write = (path: string, bytes: Uint8Array) => {
		if (options.unwritable?.includes(path) === true) return notFound("writeFile", path);
		files[path] = bytes;
		written.set(path, bytes);
		return Effect.void;
	};
	const layer = Layer.merge(
		FileSystem.layerNoop({
			readFile: (path: string) => read("readFile", path),
			readFileString: (path: string) => {
				const value = files[path];
				return value === undefined || value === null
					? notFound("readFileString", path)
					: Effect.succeed(typeof value === "string" ? value : new TextDecoder().decode(value));
			},
			exists: (path: string) =>
				options.unprobeable?.includes(path) === true
					? notFound("exists", path)
					: Effect.succeed(Object.hasOwn(files, path) && files[path] !== null),
			makeDirectory: () => Effect.void,
			realPath: (path: string) => Effect.succeed(path),
			writeFile: (path: string, data: Uint8Array) => write(path, data),
			writeFileString: (path: string, data: string) => write(path, new TextEncoder().encode(data)),
		}),
		Path.layer,
	);
	return {layer, written};
};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

const crc32 = (bytes: Buffer): number => {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
};

/** Encode an 8-bit RGBA raster as a real, decodable PNG (filter 0 on every scanline). */
export const encodePng = (width: number, height: number, rgba: Uint8Array): Uint8Array => {
	const stride = width * 4;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
};

/** A solid-colour raster, the base every diff fixture perturbs. */
export const solid = (
	width: number,
	height: number,
	rgba: readonly [number, number, number, number],
): Uint8Array => {
	const pixels = new Uint8Array(width * height * 4);
	for (let p = 0; p < width * height; p++) pixels.set(rgba, p * 4);
	return pixels;
};
