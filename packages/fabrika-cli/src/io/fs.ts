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

const NEWLINE = 0x0a;

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

/**
 * Whether `path` is a directory.
 *
 * Separate from {@link exists} because "is there a file *under* this?" is not answerable by probing
 * the child: on a non-directory parent the platform raises `ENOTDIR` rather than answering absent,
 * so a caller enumerating a tree must ask about the entry itself. Like every read here, a probe that
 * could not be performed FAILS; it never answers `false`.
 */
export const isDirectory = (
	path: string,
): Effect.Effect<boolean, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return (yield* fs.stat(path)).type === "Directory";
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);

/**
 * Append `text` to `path`, creating the file and its parent directory when they are absent.
 *
 * The `"a+"` open flag is the guarantee that matters: every write lands at the end of whatever is
 * already there, so a re-run adds to a line-oriented file rather than truncating it, and nothing on
 * disk is rewritten. The one thing done beyond that is healing a missing final newline: a file whose
 * last write was cut short ends mid-line, and appending straight onto it would fuse the new text
 * into the damaged line and lose both. A reader can skip one damaged line; it cannot recover a good
 * one that was glued to it.
 */
export const appendFile = (
	path: string,
	text: string,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
		yield* Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(path, {flag: "a+"});
				const size = (yield* file.stat).size;
				let separator = "";
				if (size > 0n) {
					yield* file.seek(size - 1n, "start");
					const last = yield* file.readAlloc(1);
					if (last._tag === "Some" && last.value[0] !== NEWLINE) separator = "\n";
				}
				yield* file.writeAll(new TextEncoder().encode(`${separator}${text}`));
			}),
		);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);

/**
 * The physically resolved `path` — symlinks followed, `.` and `..` folded.
 *
 * Load-bearing for any containment test: on macOS `/tmp` is a symlink to `/private/tmp`, so a
 * lexical prefix comparison and a resolved one give different answers about whether a path sits
 * inside a tree.
 */
export const realPath = (path: string): Effect.Effect<string, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.realPath(path);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new ReadFailed({path, reason: cause.message})),
	);

/** Create `path` and any missing parent. Already-present is success, not an error. */
export const makeDirectory = (
	path: string,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(path, {recursive: true});
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);

/**
 * Remove `path` and everything under it.
 *
 * `force` makes an already-absent path a success: a caller that re-runs a disposal has nothing to
 * remove and that is the goal state, not a fault. Whether the removal actually took is a separate
 * question every caller must ask with {@link exists} — this call landing is not evidence the
 * directory is gone.
 */
export const removeAll = (path: string): Effect.Effect<void, WriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(path, {recursive: true, force: true});
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);

/**
 * Append `text` to `path` verbatim, creating the parent directory — for a line-oriented log whose
 * **bytes** a digest is taken over.
 *
 * Deliberately not {@link appendFile}, which heals a missing final newline. That healing is right for
 * a log a human reads and wrong for one a digest covers: it inserts a byte the digest would then
 * account for, so two readers of the same appended record could compute two numbers. Here the
 * caller's own grammar guarantees each write ends in `\n`, so there is nothing to heal.
 */
export const appendText = (
	path: string,
	text: string,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
		yield* fs.writeFileString(path, text, {flag: "a"});
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);

/** Write raw bytes to `path`, creating its parent directory — for content a digest is taken over. */
export const writeBytes = (
	path: string,
	data: Uint8Array,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
		yield* fs.writeFile(path, data);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
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

/**
 * Move `path` to `to`, creating the destination's parent.
 *
 * The one primitive that relocates a directory without reading it: a copy-then-remove would read
 * every byte of an append-only log and re-emit it, which is a rewrite the reader cannot tell from
 * the original. A rename moves the inode, so the bytes a caller moved are provably the bytes that
 * were there. Like every write here, a rename that did not land FAILS — a caller never reports the
 * path as moved.
 */
export const rename = (
	path: string,
	to: string,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		yield* fs.makeDirectory(pathService.dirname(to), {recursive: true});
		yield* fs.rename(path, to);
	}).pipe(
		Effect.catchTag("PlatformError", (cause) => new WriteFailed({path, reason: cause.message})),
	);
