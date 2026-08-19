/**
 * One load of `.fabrika.jsonc` from the working tree — the door for a verb that runs against the
 * checkout it is standing in rather than against a base ref.
 *
 * Kept apart from `./load.ts`, which knows nothing about files: a verb reading at a ref
 * (`build clearances`) opens the bytes with `git show` and hands the same loader a `Text`. This is
 * the other opener, and the only platform-touching module on the surface.
 *
 * **An absent file and an unreadable one stay apart all the way down.** Absent is a repo that
 * declared nothing, so every key resolves to its shipped default; a read that failed proves nothing
 * about what the repo declared, and each key resolves UNKNOWN so its caller refuses in its own words.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, readFile} from "../io/fs.ts";
import {CONFIG_PATH, type ConfigSource} from "./document.ts";
import {type Load, loadConfig} from "./load.ts";
import {readConfigSource} from "./source.ts";

/**
 * The config at the repo root above `cwd`, loaded.
 *
 * Above `cwd` rather than at it, because a verb is run from wherever the operator happens to stand
 * and a config read only at the top level would resolve to the shipped defaults for every run from a
 * subdirectory — a silent, invisible widening. A `cwd` in no repository at all falls back to itself,
 * which changes nothing: there is no file there either, and the answer is the shipped defaults.
 */
export const loadRepoConfig = (
	cwd: string,
): Effect.Effect<Load, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* Effect.result(discoverRepoRoot(cwd));
		if (root._tag === "Failure") {
			return loadConfig({
				_tag: "Unreadable",
				reason: `cannot resolve the repo root above ${cwd}: ${root.failure.reason}`,
			});
		}
		const path = `${root.success ?? cwd}/${CONFIG_PATH}`;
		// Probed rather than inferred from the read's error text: an absent file and a denied one are
		// opposite answers here, and sniffing `ENOENT` out of a message would read a permission fault
		// as "this repo declared nothing".
		const there = yield* Effect.result(exists(path));
		const source: ConfigSource = yield* Effect.gen(function* () {
			if (there._tag === "Failure") {
				return {_tag: "Unreadable", reason: `${path}: ${there.failure.reason}`} as const;
			}
			if (!there.success) return {_tag: "Absent"} as const;
			const read = yield* Effect.result(readFile(path));
			return read._tag === "Success"
				? ({_tag: "Text", text: read.success} as const)
				: ({_tag: "Unreadable", reason: `${path}: ${read.failure.reason}`} as const);
		});
		return loadConfig(source);
	});

/**
 * The config source at the repo root above `cwd` — the same discovery {@link loadRepoConfig} makes,
 * for a reader that wants the arm rather than a loaded document.
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
		if (root._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				reason: `cannot resolve the repo root above ${cwd}: ${root.failure.reason}`,
			};
		}
		return yield* readConfigSource(root.success ?? cwd);
	});
