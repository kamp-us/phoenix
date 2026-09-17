/**
 * Open a config file off a directory and report which of the three arms was found.
 *
 * The whole job is keeping "nobody wrote a config" apart from "nobody could read the config": an
 * absent file is `Absent` and every key falls to its shipped default, while a probe or a read that
 * *failed* is `Unreadable` and every key resolves UNKNOWN. `exists` already fails rather than
 * answering `false` on an unreadable parent (see `../io/fs.ts`), so the distinction survives the
 * probe as well as the read.
 *
 * Both files open through the one reader, because the arms and their meanings are the same for
 * both. What differs is what an `Absent` says: for the tracked file it is a repo that declared
 * nothing, and for the local one a machine that declared nothing.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {Effect, type FileSystem, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {CONFIG_PATH, type ConfigSource, LOCAL_CONFIG_PATH} from "./document.ts";
import type {ConfigLayers} from "./load.ts";

const readSourceAt = (
	root: string,
	name: string,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = `${root}/${name}`;
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

/** The tracked config file as it sits under `root`. Never fails: an unreadable file is an arm. */
export const readConfigSource = (
	root: string,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem> => readSourceAt(root, CONFIG_PATH);

/** The machine-local file as it sits under `root`, beside the tracked one. */
export const readLocalConfigSource = (
	root: string,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem> =>
	readSourceAt(root, LOCAL_CONFIG_PATH);

/** Both layers under `root`, which is what a working-tree read resolves against. */
export const readConfigLayers = (
	root: string,
): Effect.Effect<ConfigLayers, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		return {
			tracked: yield* readConfigSource(root),
			local: yield* readLocalConfigSource(root),
		};
	});
