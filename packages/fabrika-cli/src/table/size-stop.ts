/**
 * The one stop the rulings allow: a lane whose row has spent its stop multiple of its size stops
 * before its next shell. Everything short of that is a flag and the lane keeps going.
 *
 * It reads the rows the lane's issue reaches — its own, its epic's, the chains it blocks — through
 * the flags' own reader and asks {@link stopOf}, so a lane stops exactly when its row reads
 * `stopped` in `table flags`.
 *
 * **No table is no stop.** A repository that never set a table up has no sizes to spend past, so it
 * is `Clear`. A table that could not be read is `Unknown`, never clear.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {tableKey} from "../config/keys/table.ts";
import {resolve} from "../config/load.ts";
import {readKey} from "../config/read-key.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import {withProjects} from "../io/projects.ts";
import {NO_TARGET, SCOPE_MISSING} from "./codes.ts";
import {type OverSize, recOf, stopOf} from "./flags.ts";
import {readHeads} from "./flags-read.ts";
import {locateTable, syncBoard, type TableBoard} from "./sync-verb.ts";

export type SizeStop =
	| {readonly _tag: "Clear"; readonly note: string}
	| {readonly _tag: "Stopped"; readonly flag: OverSize; readonly rec: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const readSizeStop = <R>(
	board: TableBoard<R>,
	verb: string,
	cwd: string,
	repo: string,
	issue: number,
): Effect.Effect<SizeStop, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const config = resolve(yield* loadRepoConfig(cwd), tableKey);
		if (config._tag === "Malformed" || config._tag === "Unknown") {
			return {_tag: "Unknown", reason: `the \`table\` config: ${config.reason}`};
		}
		const sizes = yield* readKey(cwd, appetiteSizesKey);
		if (sizes._tag === "Refused") return {_tag: "Unknown", reason: sizes.reason};
		const settings = config.value;
		const heads = yield* readHeads(board, verb, repo, settings, [issue]);
		if (heads._tag === "Refused") {
			if (heads.code === NO_TARGET && settings.project.number === null) {
				return {_tag: "Clear", note: `no table project, so #${issue} has no size to stop at`};
			}
			if (heads.code === SCOPE_MISSING && config._tag === "Default") {
				return {
					_tag: "Clear",
					note: `no table read — ${heads.reason.replace(/\.$/, "")}, if this repository keeps one`,
				};
			}
			return {_tag: "Unknown", reason: heads.reason};
		}
		const flag = stopOf(heads.rows, {settings, sizes: sizes.value, records: heads.records}, issue);
		return flag === null
			? {
					_tag: "Clear",
					note: `#${issue} stands on no row that has spent ${settings.stopMultiple}x its size`,
				}
			: {_tag: "Stopped", flag, rec: recOf(flag, settings)};
	});

/** The size stop read off GitHub under the ambient token, with `verb` naming the reader. */
export const sizeStopOnGitHub =
	(verb: string, cwd: string) =>
	(
		repo: string,
		issue: number,
	): Effect.Effect<
		SizeStop,
		never,
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
	> =>
		readSizeStop(
			{
				locate: (target, settings) =>
					withProjects((token) => locateTable(token, target, settings, verb)),
				items: syncBoard.items,
				node: syncBoard.node,
				comments: syncBoard.comments,
			},
			verb,
			cwd,
			repo,
			issue,
		);
