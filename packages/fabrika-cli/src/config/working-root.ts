/**
 * One load of the config surface from the working tree — the door for a verb that runs against the
 * checkout it is standing in rather than against a base ref.
 *
 * Kept apart from `./load.ts`, which knows nothing about files: a verb reading at a ref
 * (`build clearances`) opens the bytes with `git show` and hands the same loader a `Text`. This is
 * the other opener, and the only platform-touching module on the surface. It is also the only one
 * that reads the machine-local layer, because that file exists nowhere but a working tree.
 *
 * **An absent file and an unreadable one stay apart all the way down.** Absent is a repo that
 * declared nothing, so every key resolves to its shipped default; a read that failed proves nothing
 * about what the repo declared, and each key resolves UNKNOWN so its caller refuses in its own words.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {Effect, type FileSystem, type Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import type {ConfigSource} from "./document.ts";
import {type ConfigLayers, type Load, loadLayeredConfig} from "./load.ts";
import {readConfigLayers, readConfigSource} from "./source.ts";

/**
 * The config at the repo root above `cwd`, both layers, loaded.
 *
 * Above `cwd` rather than at it, because a verb is run from wherever the operator happens to stand
 * and a config read only at the top level would resolve to the shipped defaults for every run from a
 * subdirectory — a silent, invisible widening. A `cwd` in no repository at all falls back to itself,
 * which changes nothing: there is no file there either, and the answer is the shipped defaults.
 *
 * The three arms come from {@link repoConfigLayers}, which is the one opener; this is that answer
 * loaded. Two openers with the same three-arm semantics is drift bait, so there is only one.
 */
export const loadRepoConfig = (
	cwd: string,
): Effect.Effect<Load, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		return loadLayeredConfig(yield* repoConfigLayers(cwd));
	});

/**
 * The tracked config source at the repo root above `cwd` — the same discovery
 * {@link loadRepoConfig} makes, for a reader that wants the arm rather than a loaded document.
 *
 * A discovery that *failed* is `Unreadable`, never a fall back to `cwd`: falling back would find no
 * file there and answer `Absent`, which is the claim "this repo declared nothing" about a repo
 * nobody located. A discovery that *succeeded and found nothing* still falls to `cwd` — that is a
 * real directory with no config in it, and the answer is the same either way. Keeping those two
 * apart is the whole reason `ConfigSource` has three arms.
 */
export const repoConfigSource = (
	cwd: string,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* Effect.result(discoverRepoRoot(cwd));
		if (root._tag === "Failure") return unlocated(cwd, root.failure.reason);
		return yield* readConfigSource(root.success ?? cwd);
	});

/** Both layers at the repo root above `cwd`, under the same discovery rule. */
export const repoConfigLayers = (
	cwd: string,
): Effect.Effect<ConfigLayers, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* Effect.result(discoverRepoRoot(cwd));
		if (root._tag === "Failure") {
			// A root nobody located leaves BOTH layers unread. Answering `Absent` for the local one
			// would be the claim "this machine declared nothing" about a machine nobody looked at, and
			// a per-key fall-through to a tracked layer that is itself UNKNOWN reads as the same green.
			const reason = unlocated(cwd, root.failure.reason);
			return {tracked: reason, local: reason};
		}
		return yield* readConfigLayers(root.success ?? cwd);
	});

const unlocated = (cwd: string, reason: string): ConfigSource => ({
	_tag: "Unreadable",
	reason: `cannot resolve the repo root above ${cwd}: ${reason}`,
});
