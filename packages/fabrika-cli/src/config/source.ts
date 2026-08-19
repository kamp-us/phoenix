/**
 * Open `.fabrika.jsonc` off a directory and report which of the three arms was found.
 *
 * The whole job is keeping "nobody wrote a config" apart from "nobody could read the config": an
 * absent file is `Absent` and every key falls to its shipped default, while a probe or a read that
 * *failed* is `Unreadable` and every key resolves UNKNOWN. `exists` already fails rather than
 * answering `false` on an unreadable parent (see `../io/fs.ts`), so the distinction survives the
 * probe as well as the read.
 */

import {Effect, type FileSystem, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {CONFIG_PATH, type ConfigSource} from "./document.ts";

/** The config file as it sits under `root`. Never fails: an unreadable file is an arm, not an error. */
export const readConfigSource = (
	root: string,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = `${root}/${CONFIG_PATH}`;
		const probe = yield* Effect.result(exists(path));
		if (Result.isFailure(probe)) {
			return {_tag: "Unreadable" as const, reason: `${path}: ${probe.failure.reason}`};
		}
		if (!probe.success) return {_tag: "Absent" as const};
		const text = yield* Effect.result(readFile(path));
		return Result.isFailure(text)
			? {_tag: "Unreadable" as const, reason: `${path}: ${text.failure.reason}`}
			: {_tag: "Text" as const, text: text.success};
	});
