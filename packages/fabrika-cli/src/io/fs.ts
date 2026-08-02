/**
 * The filesystem seam — Effect's `FileSystem` / `Path` services, per
 * [.patterns/effect-platform-access.md](../../../../.patterns/effect-platform-access.md). The whole
 * filesystem is the substitutable seam, so a unit test provides a scripted `FileSystem` layer
 * instead of a hand-rolled double, and `run.ts`'s `NodeServices.layer` is what satisfies it.
 *
 * **"I could not read this" is a failure, never an empty value.** An unreadable directory that came
 * back as `[]` would be indistinguishable from a directory that is genuinely empty, and the two take
 * opposite branches: one is a refusal, the other (for `adr new`) is fine. The platform's
 * `PlatformError` is lowered here into a tagged {@link ReadFailed} / {@link WriteFailed}, so that
 * discrimination rides the `E` channel — a caller cannot reach the value without deciding what to do
 * with the failure, where a `null` sentinel could simply go untested.
 */
import {Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";

/** A path could not be read — never conflated with a path that was read and held nothing. */
export class ReadFailed extends Schema.TaggedErrorClass<ReadFailed>()("fabrika-cli/ReadFailed", {
	path: Schema.String,
	reason: Schema.String,
}) {}

/** A write did not land. The caller refuses; it never reports the path as written. */
export class WriteFailed extends Schema.TaggedErrorClass<WriteFailed>()("fabrika-cli/WriteFailed", {
	path: Schema.String,
	reason: Schema.String,
}) {}

/** Base names in `path`. A directory that could not be listed FAILS; it never resolves to `[]`. */
export const readDir = (
	path: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readDirectory(path);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);

/** The file's UTF-8 text. A file that could not be read FAILS; it never resolves to `""`. */
export const readFile = (path: string): Effect.Effect<string, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);

/**
 * Whether `path` exists.
 *
 * A probe that could not be *performed* fails rather than answering `false`: `node:fs`'s
 * `existsSync` reports an unreadable parent directory as "absent", which would license `adr new` to
 * attempt a write over a record it never managed to look at.
 */
export const exists = (path: string): Effect.Effect<boolean, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.exists(path);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);

/** Write `text` to `path`, creating its parent directory. */
export const writeFile = (
	path: string,
	text: string,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
		yield* fs.writeFileString(path, text);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);
