/**
 * Binary reads and writes through the `FileSystem` seam — PNGs, which `../io/fs.ts` has no shape for
 * (it is UTF-8 text throughout). Same discipline: a read that could not be *performed* fails, so an
 * unreadable capture is never indistinguishable from an empty one.
 */
import {Effect, FileSystem, Path} from "effect";

export type ByteRead =
	| {readonly _tag: "Bytes"; readonly bytes: Uint8Array}
	| {readonly _tag: "Failed"; readonly reason: string};

export const readBytes = (path: string): Effect.Effect<ByteRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return {_tag: "Bytes" as const, bytes: yield* fs.readFile(path)};
	}).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.succeed<ByteRead>({_tag: "Failed", reason: cause.message}),
		),
	);

export const writeBytes = (
	path: string,
	bytes: Uint8Array,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
		yield* fs.writeFile(path, bytes);
		return null;
	}).pipe(Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)));

export const writeText = (
	path: string,
	text: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	writeBytes(path, new TextEncoder().encode(text));
