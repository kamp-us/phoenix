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
 * A save is a file whose modification time moved past the stamp the watcher holds for it, and a
 * file's stamp is taken before the reload that reads it. So a save that lands while a reload runs,
 * whose event fired when no watch was armed, still differs from its stamp, and the next watch's
 * sweep reloads again.
 *
 * A refused reload keeps the previous set and adds every file the refused read imported
 * (`ReloadRefused.files`). The desk stays on the generation it was running, and the author's next
 * save of the file that broke it is seen, including a file only the refused config imports.
 */

import {basename, dirname, join} from "node:path";
import {Console, Duration, Effect, FileSystem, Option, Stream} from "effect";
import type {ReloadRefused, ReloadReport} from "./reload.ts";

export interface WatchConfigOptions {
	/** The files the running generation was read from. */
	readonly files: ReadonlyArray<string>;
	readonly reload: Effect.Effect<ReloadReport, ReloadRefused>;
	/** How long a directory has to be quiet before a save counts. Defaults to 100 ms. */
	readonly quiet?: Duration.Input;
}

/** A file's modification time, or `undefined` for one that is not there to stat. */
const modifiedAt = (fs: FileSystem.FileSystem, path: string) =>
	fs.stat(path).pipe(
		Effect.map((info) => Option.getOrUndefined(Option.map(info.mtime, (at) => at.getTime()))),
		Effect.orElseSucceed(() => undefined),
	);

/** Each file beside its modification time when it was stamped, `undefined` when it was absent. */
type Stamps = ReadonlyMap<string, number | undefined>;

const stampAll = (fs: FileSystem.FileSystem, files: Iterable<string>) =>
	Effect.map(
		Effect.forEach(files, (file) => Effect.map(modifiedAt(fs, file), (at) => [file, at] as const), {
			concurrency: "unbounded",
		}),
		(entries): Stamps => new Map(entries),
	);

/**
 * `files`, each keeping the stamp `before` holds for it. A file `before` never held is one the
 * reload read for the first time, and it is stamped now.
 */
const restamp = (fs: FileSystem.FileSystem, before: Stamps, files: ReadonlyArray<string>) =>
	Effect.map(
		stampAll(
			fs,
			files.filter((file) => !before.has(file)),
		),
		(fresh): Stamps =>
			new Map(files.map((file) => [file, before.has(file) ? before.get(file) : fresh.get(file)])),
	);

/**
 * Resolves on the first save of any stamped file once its directory has gone quiet. Watch events
 * are one way to notice a save, and one sweep of every file, once the watches have had `quiet` to
 * arm, is the other: it finds a save that landed before the watch existed. Comparing against the
 * stamp also drops FSEvents on macOS replaying a write from just before the watch was armed.
 */
const nextSave = (fs: FileSystem.FileSystem, stamps: Stamps, quiet: Duration.Input) =>
	Effect.gen(function* () {
		// A desk booted from no config module has nothing to save; an empty merge would end at once.
		if (stamps.size === 0) return yield* Effect.never;
		const files = [...stamps.keys()];
		const directories = [...new Set(files.map(dirname))];
		const events = directories.map((directory) =>
			fs.watch(directory).pipe(Stream.map((event) => join(directory, basename(event.path)))),
		);
		const sweep = Stream.fromEffect(Effect.sleep(quiet)).pipe(
			Stream.flatMap(() => Stream.fromIterable(files)),
		);
		yield* Stream.mergeAll([...events, sweep], {concurrency: "unbounded"}).pipe(
			Stream.filterEffect((path) =>
				stamps.has(path)
					? Effect.map(modifiedAt(fs, path), (at) => at !== stamps.get(path))
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
	let stamps = yield* stampAll(fs, files);
	while (true) {
		yield* nextSave(fs, stamps, quiet);
		const current = [...stamps.keys()];
		const before = yield* stampAll(fs, current);
		const next = yield* reload.pipe(
			Effect.matchEffect({
				onSuccess: (report) =>
					Console.log(
						`tuval: config reloaded — ${report.spellCount} spell(s), ${report.notified} process(es) told, ${report.files.length} file(s) watched`,
					).pipe(Effect.as(report.files)),
				onFailure: (refused) =>
					Console.error(`tuval: config reload refused — ${refused.message}`).pipe(
						Effect.as([...new Set([...current, ...refused.files])]),
					),
			}),
		);
		stamps = yield* restamp(fs, before, next);
	}
});
