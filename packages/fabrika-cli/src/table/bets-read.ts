/**
 * Read the bet order off the repository's table project, for a verb that ranks work by it.
 *
 * The project is found the way `table setup` finds it, read-only: the number `table.project` names,
 * or else the one open project linked to the repository under the table's title. **No project is an
 * answer, not a failure**: a repository that never set a table up gets `NoTable`, and its caller
 * behaves exactly as it did before tables existed.
 *
 * A token without the `project` scope splits on whether the repository declared a `table` block.
 * Declared, it is the table's own refusal and names the fix, the same one `table setup` names.
 * Undeclared, the repository never asked for a table, so a missing scope is `NoTable` with the fix
 * named in the note, rather than a new refusal on every verb that ranks work.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type TableSettings, tableKey} from "../config/keys/table.ts";
import {resolve} from "../config/load.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import type {Api} from "../io/gh-api.ts";
import type {Shell} from "../io/git.ts";
import {
	type Board,
	type ProjectsAnswer,
	readBoard,
	readProjectByNumber,
	readRepository,
	withProjects,
} from "../io/projects.ts";
import {type BetOrder, betOrder} from "./bets.ts";
import {defaultTitle, FIELD} from "./shape.ts";

/** Which project a bet order came from, as `owner#number`. */
export interface BetSource {
	readonly owner: string;
	readonly number: number;
}

export type BetsRead =
	/** The repository has no table project; `note` says why, for the caller's stderr. */
	| {readonly _tag: "NoTable"; readonly note: string}
	| {readonly _tag: "Read"; readonly source: BetSource; readonly order: BetOrder}
	/** The table could not be read. UNKNOWN — never read as "no bets". */
	| {readonly _tag: "Unknown"; readonly reason: string};

interface Located {
	readonly id: string;
	readonly source: BetSource;
}

const failed = <A>(reason: string): ProjectsAnswer<A> => ({_tag: "Failed", reason});

const locate = (
	token: string,
	repo: string,
	settings: TableSettings,
): Api<ProjectsAnswer<Located | null>> =>
	Effect.gen(function* () {
		const [repoOwner = repo] = repo.split("/");
		const wanted = settings.project.number;
		if (wanted !== null) {
			const owner = settings.project.owner ?? repoOwner;
			const read = yield* readProjectByNumber(token, owner, wanted);
			if (read._tag !== "Ok") return read;
			return read.value === null
				? failed<Located | null>(
						`\`table.project\` names project ${wanted} under ${owner}, and ${owner} has no such project`,
					)
				: {_tag: "Ok", value: {id: read.value.id, source: {owner, number: wanted}}};
		}
		const node = yield* readRepository(token, repo);
		if (node._tag !== "Ok") return node;
		const title = defaultTitle(repo);
		const titled = node.value.linkedProjects.filter((ref) => ref.title === title && !ref.closed);
		const [only, ...more] = titled;
		if (only === undefined) return {_tag: "Ok", value: null};
		if (more.length > 0) {
			return failed<Located | null>(
				`${titled.length} open projects linked to ${repo} are titled "${title}" (${titled.map((ref) => `#${ref.number}`).join(", ")}) — set \`table.project.number\` to the one that is the table`,
			);
		}
		return {
			_tag: "Ok",
			value: {id: only.id, source: {owner: node.value.owner.login, number: only.number}},
		};
	});

type Found =
	| {readonly _tag: "None"}
	| {readonly _tag: "Board"; readonly source: BetSource; readonly board: Board};

const readTable = (repo: string, settings: TableSettings): Shell<ProjectsAnswer<Found>> =>
	withProjects<Found>((token) =>
		Effect.gen(function* () {
			const located = yield* locate(token, repo, settings);
			if (located._tag !== "Ok") return located;
			if (located.value === null) return {_tag: "Ok", value: {_tag: "None"}};
			const board = yield* readBoard(token, located.value.id, {
				stage: FIELD.stage,
				section: FIELD.section,
				iteration: FIELD.week,
			});
			return board._tag === "Ok"
				? {_tag: "Ok", value: {_tag: "Board", source: located.value.source, board: board.value}}
				: board;
		}),
	);

export const readBets = (
	cwd: string,
	repo: string,
	now: Date,
): Effect.Effect<
	BetsRead,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const config = resolve(yield* loadRepoConfig(cwd), tableKey);
		if (config._tag === "Malformed" || config._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: `the \`table\` config: ${config.reason}`};
		}
		const read = yield* readTable(repo, config.value);
		switch (read._tag) {
			case "MissingScope":
				return config._tag === "Declared"
					? {_tag: "Unknown" as const, reason: read.reason}
					: {
							_tag: "NoTable" as const,
							note: `no table read — ${read.reason}, if this repository keeps one`,
						};
			case "Failed":
				return {_tag: "Unknown" as const, reason: `the table project: ${read.reason}`};
			default:
				return read.value._tag === "None"
					? {
							_tag: "NoTable" as const,
							note: `no table project — none is configured, and none titled "${defaultTitle(repo)}" is linked to ${repo}`,
						}
					: {
							_tag: "Read" as const,
							source: read.value.source,
							order: betOrder(read.value.board, config.value.sections, now),
						};
		}
	});
