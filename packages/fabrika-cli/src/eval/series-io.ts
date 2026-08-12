/**
 * Reading the committed scorecard series off disk — the one place that decides what a member is.
 *
 * It exists as its own module because two callers need the same read and neither may own it: the
 * `trend` / `churn` verbs (#4680) and the merge gate's advisory leg (#4681). A second copy of the
 * membership rule is precisely the drift that took the series down once already.
 *
 * Members are selected by `isSeriesFileName`, never by `*.json`: the directory also holds the dated
 * cost baselines (#4679), and globbing every JSON there made each of those a malformed scorecard. A
 * name that *is* a member and does not decode is still a hard refusal — that is a corrupt point of
 * the series rather than a neighbour.
 *
 * The result is a total value rather than an exit: a shared read that terminated the process would
 * decide its callers' exit codes for them.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {CommittedScorecard} from "./committed-scorecard.ts";
import {decodeCommittedScorecard, isSeriesFileName} from "./committed-scorecard.ts";

export interface SeriesFile {
	readonly fileName: string;
	readonly scorecard: CommittedScorecard;
}

export type SeriesRead =
	| {
			readonly _tag: "Files";
			readonly files: ReadonlyArray<SeriesFile>;
			/** JSON files in the directory that name no point of the series — reported, never read. */
			readonly ignored: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Unreadable"; readonly path: string}
	| {readonly _tag: "Malformed"; readonly path: string; readonly reason: string};

/** Every committed scorecard in `dir`, oldest name first. An absent directory reads as no points. */
export const readSeriesFiles = (
	dir: string,
): Effect.Effect<SeriesRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
			return {_tag: "Files", files: [], ignored: []} as SeriesRead;
		}
		const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => null));
		if (entries === null) return {_tag: "Unreadable", path: dir} as SeriesRead;

		const files: Array<SeriesFile> = [];
		for (const name of entries.filter(isSeriesFileName).sort()) {
			const full = path.join(dir, name);
			const text = yield* fs.readFileString(full).pipe(Effect.orElseSucceed(() => null));
			if (text === null) return {_tag: "Unreadable", path: full} as SeriesRead;
			const decoded = decodeCommittedScorecard(text);
			if (Result.isFailure(decoded)) {
				return {
					_tag: "Malformed",
					path: full,
					reason: `${decoded.failure.reason}: ${decoded.failure.message}`,
				} as SeriesRead;
			}
			files.push({fileName: name, scorecard: decoded.success});
		}
		return {
			_tag: "Files",
			files,
			ignored: entries.filter((name) => name.endsWith(".json") && !isSeriesFileName(name)).sort(),
		} as SeriesRead;
	});
