/**
 * Read the repository's table project: the bet order a verb ranks work by, or any other reader
 * handed to {@link readTableWith}.
 *
 * The project is found the way `table setup` finds it, read-only: the number `table.project` names,
 * or else the one open project linked to the repository under the table's title. **No project is an
 * answer, not a failure**: a repository that never set a table up gets `NoTable`, and its caller
 * behaves exactly as it did before tables existed.
 *
 * A table that could not be read splits on whether the repository adopted one (`./adoption.ts`).
 * Adopted, it is `Unknown` and a missing scope names the fix, the same one `table setup` names. Not
 * adopted, any failed read — a missing scope, a rate limit, an outage, a forbidden token — is
 * `NoTable` with the reason in its note, rather than a new refusal on every verb that ranks work.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {TableSettings} from "../config/keys/table.ts";
import type {Api} from "../io/gh-api.ts";
import type {Shell} from "../io/git.ts";
import {
	type ProjectsAnswer,
	readBoard,
	readProjectByNumber,
	readRepository,
	withProjects,
} from "../io/projects.ts";
import {failedRead, type Known, readAdoption} from "./adoption.ts";
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

/** What one table reader reads off the located project. */
export type TableReader<A> = (
	token: string,
	projectId: string,
	settings: TableSettings,
) => Api<ProjectsAnswer<A>>;

export type Found<A> =
	| {readonly _tag: "None"}
	| {readonly _tag: "Table"; readonly source: BetSource; readonly value: A};

const readTable = <A>(
	repo: string,
	settings: TableSettings,
	read: TableReader<A>,
): Shell<ProjectsAnswer<Found<A>>> =>
	withProjects<Found<A>>((token) =>
		Effect.gen(function* () {
			const located = yield* locate(token, repo, settings);
			if (located._tag !== "Ok") return located;
			if (located.value === null) return {_tag: "Ok", value: {_tag: "None"}};
			const value = yield* read(token, located.value.id, settings);
			return value._tag === "Ok"
				? {_tag: "Ok", value: {_tag: "Table", source: located.value.source, value: value.value}}
				: value;
		}),
	);

export type TableRead<A> =
	/** The repository has no table project; `note` says why, for the caller's stderr. */
	| {readonly _tag: "NoTable"; readonly note: string}
	| {readonly _tag: "Read"; readonly source: BetSource; readonly value: A}
	/** The table could not be read. UNKNOWN — never read as an empty table. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** What one table read means for its reader, given whether the repository adopted a table. */
export const tableReadOf = <A>(
	adoption: Known,
	repo: string,
	found: ProjectsAnswer<Found<A>>,
): TableRead<A> => {
	if (found._tag !== "Ok") {
		const failed = failedRead(
			adoption,
			found._tag === "MissingScope" ? found.reason : `the table project: ${found.reason}`,
		);
		return failed._tag === "Unknown"
			? failed
			: {
					_tag: "NoTable",
					note: `no table read — ${failed.reason}; .fabrika.jsonc declares no \`table\` block, so none is required`,
				};
	}
	return found.value._tag === "None"
		? {
				_tag: "NoTable",
				note: `no table project — none is configured, and none titled "${defaultTitle(repo)}" is linked to ${repo}`,
			}
		: {_tag: "Read", source: found.value.source, value: found.value.value};
};

/**
 * Find the table and run `read` against it. Every reader of the table comes through here, so they
 * all agree on when a repository has no table.
 */
export const readTableWith = <A>(
	cwd: string,
	repo: string,
	read: TableReader<A>,
): Effect.Effect<
	TableRead<A>,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const adoption = yield* readAdoption(cwd);
		if (adoption._tag === "Unknown") return adoption;
		return tableReadOf(adoption, repo, yield* readTable(repo, adoption.settings, read));
	});

export const readBets = (
	cwd: string,
	repo: string,
	now: Date,
): Effect.Effect<
	BetsRead,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.map(
		readTableWith(cwd, repo, (token, projectId, settings) =>
			Effect.map(
				readBoard(token, projectId, {
					stage: FIELD.stage,
					section: FIELD.section,
					iteration: FIELD.week,
				}),
				(board): ProjectsAnswer<BetOrder> =>
					board._tag === "Ok"
						? {_tag: "Ok", value: betOrder(board.value, settings.sections, now)}
						: board,
			),
		),
		(read): BetsRead =>
			read._tag === "Read" ? {_tag: "Read", source: read.source, order: read.value} : read,
	);
