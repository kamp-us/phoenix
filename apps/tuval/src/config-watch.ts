/**
 * The running desk's hot reload: watch every file the config was read from, and reload when one of
 * them is saved (#9667). The set is the one the last good load recorded (`LoadedConfig.files`), so
 * a program file the config imports is watched exactly as the config module is, and a file the
 * config stops importing stops being watched.
 *
 * Directories are watched, not files: an editor that saves by writing a new file and renaming it
 * over the old one leaves a watch on the old file watching nothing. A burst of events from one save
 * is one reload, after the directory has been quiet for `quiet`.
 *
 * A refused reload keeps the previous set. The desk stays on the generation it was running, and the
 * author's next save of the file that broke it is still seen.
 */

import {basename, dirname, join} from "node:path";
import {Console, Duration, Effect, FileSystem, Option, Stream} from "effect";
import type {ReloadError, ReloadReport} from "./reload.ts";

export interface WatchConfigOptions {
	/** The files the running generation was read from. */
	readonly files: ReadonlyArray<string>;
	readonly reload: Effect.Effect<ReloadReport, ReloadError>;
	/** How long a directory has to be quiet before a save counts. Defaults to 100 ms. */
	readonly quiet?: Duration.Input;
}

/** A file's modification time, or `undefined` for one that is not there to stat. */
const modifiedAt = (fs: FileSystem.FileSystem, path: string) =>
	fs.stat(path).pipe(
		Effect.map((info) => Option.getOrUndefined(Option.map(info.mtime, (at) => at.getTime()))),
		Effect.orElseSucceed(() => undefined),
	);

/**
 * Resolves on the first save of any of `files` once their directories have gone quiet. A save is an
 * event whose file's modification time moved since the watch began: FSEvents on macOS can replay a
 * write from just before the watch was armed, and a replay is not a save.
 */
const nextSave = (fs: FileSystem.FileSystem, files: ReadonlyArray<string>, quiet: Duration.Input) =>
	Effect.gen(function* () {
		// A desk booted from no config module has nothing to save; an empty merge would end at once.
		if (files.length === 0) return yield* Effect.never;
		const armedAt = new Map(
			yield* Effect.forEach(files, (file) =>
				Effect.map(modifiedAt(fs, file), (at) => [file, at] as const),
			),
		);
		const directories = [...new Set(files.map(dirname))];
		yield* Stream.mergeAll(
			directories.map((directory) =>
				fs.watch(directory).pipe(Stream.map((event) => join(directory, basename(event.path)))),
			),
			{concurrency: "unbounded"},
		).pipe(
			Stream.filterEffect((path) =>
				armedAt.has(path)
					? Effect.map(modifiedAt(fs, path), (at) => at !== armedAt.get(path))
					: Effect.succeed(false),
			),
			Stream.debounce(quiet),
			Stream.take(1),
			Stream.runDrain,
		);
	});

/** Runs until interrupted, or until a watch itself fails; the desk runs on either way. */
export const watchConfig = Effect.fn("Tuval.watchConfig")(function* ({
	files,
	reload,
	quiet = Duration.millis(100),
}: WatchConfigOptions) {
	const fs = yield* FileSystem.FileSystem;
	let current = files;
	while (true) {
		yield* nextSave(fs, current, quiet);
		current = yield* reload.pipe(
			Effect.matchEffect({
				onSuccess: (report) =>
					Console.log(
						`tuval: config reloaded — ${report.spellCount} spell(s), ${report.notified} process(es) told, ${report.files.length} file(s) watched`,
					).pipe(Effect.as(report.files)),
				onFailure: (error) =>
					Console.error(`tuval: config reload refused — ${error.message}`).pipe(Effect.as(current)),
			}),
		);
	}
});
