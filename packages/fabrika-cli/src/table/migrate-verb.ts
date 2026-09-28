/**
 * `table migrate-week` — date every row by its Week iteration, once, so a table set up before
 * Table day keeps the tables it already held.
 *
 * Each item whose legacy Week cell names an iteration gets that iteration's start date in Table day.
 * An iteration starts on its table's day, so the start date is the row's table. **A row already
 * dated is left as it is**: prep, or a person, dated it after the Week field stopped mattering, and
 * that date is the newer fact. So a second run finds nothing to date and writes nothing.
 *
 * **It never writes the Week field.** It reads the field's iterations and each item's cell, and its
 * only write is an item's Table day value. GitHub's API changes an iteration field only by rewriting
 * its whole iteration list, which empties every row's Week — the reason Table day exists.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import {resolveRepo} from "../io/issues.ts";
import {
	type IterationHistory,
	type ProjectItem,
	type ProjectsAnswer,
	readIterationHistory,
	withProjects,
} from "../io/projects.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	CONFIG_MALFORMED,
	NOT_SET_UP,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SCOPE_MISSING,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {FIELD, LEGACY_WEEK, productBoard} from "./shape.ts";
import {locateTable, type SyncBoard, syncBoard} from "./sync-verb.ts";
import {parseTableDay, type TableDay} from "./table-day.ts";

const VERB = "table migrate-week";

/** Every board act the verb takes, passed in so the verb stays provable offline. */
export interface MigrateBoard<R> extends Pick<SyncBoard<R>, "locate" | "items" | "set"> {
	/** The legacy Week field's iterations, read only; `null` when the project has no such field. */
	readonly week: (
		projectId: string,
	) => Effect.Effect<ProjectsAnswer<IterationHistory | null>, never, R>;
}

export interface MigrateOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly board: MigrateBoard<R>;
}

/** One item to date, and the day its Week iteration started. */
export interface Dating {
	readonly itemId: string;
	/** The issue or pull request the item stands for; `null` for a draft. */
	readonly issue: number | null;
	readonly tableDay: TableDay;
}

/** An item whose Week cell names an iteration the field no longer lists. */
export interface Unresolved {
	readonly itemId: string;
	readonly issue: number | null;
	readonly iteration: string;
}

export interface Migration {
	readonly dating: ReadonlyArray<Dating>;
	readonly unresolved: ReadonlyArray<Unresolved>;
}

/**
 * What the migration writes: every item with a Week iteration and an empty Table day, dated by that
 * iteration's start. Pure, so "a second run writes nothing" is a property of this plan over items
 * already dated.
 */
export const planMigration = (
	items: ReadonlyArray<ProjectItem>,
	history: IterationHistory,
): Migration => {
	const startOf = new Map(
		[...history.running, ...history.completed].map((one) => [one.id, one.startDate] as const),
	);
	const dating: Dating[] = [];
	const unresolved: Unresolved[] = [];
	for (const item of items) {
		const dated = item.values.some(
			(value) => value.fieldName === FIELD.tableDay && value.value._tag === "Date",
		);
		const week = item.values.find(
			(value) => value.fieldName === LEGACY_WEEK && value.value._tag === "Iteration",
		)?.value;
		if (dated || week?._tag !== "Iteration") continue;
		const start = startOf.get(week.iterationId);
		const day = start === undefined ? null : parseTableDay(start);
		if (day === null) {
			unresolved.push({
				itemId: item.itemId,
				issue: item.contentNumber,
				iteration: week.title,
			});
			continue;
		}
		dating.push({itemId: item.itemId, issue: item.contentNumber, tableDay: day});
	}
	return {dating, unresolved};
};

const itemName = (one: {readonly itemId: string; readonly issue: number | null}): string =>
	one.issue === null ? `item ${one.itemId}` : `#${one.issue}`;

export const runMigrate = <R>(
	options: MigrateOptions<R>,
): Effect.Effect<
	VerbOutcome,
	never,
	R | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const settings = yield* readKey(options.cwd, tableKey);
		if (settings._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${settings.reason}. Nothing was read from GitHub.`);
		}
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository whose table to migrate.`,
			);
		}
		const repo = resolved.value;
		const {board} = options;
		const failed = (
			read: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
			onFailure: number,
			what: string,
		): VerbOutcome =>
			read._tag === "MissingScope"
				? refuse(SCOPE_MISSING, `${VERB}: ${read.reason}.`)
				: refuse(onFailure, `${VERB}: ${what}: ${read.reason}.`);

		const located = yield* board.locate(repo, productBoard(repo, settings.value));
		if (located._tag !== "Ok")
			return failed(located, PRECONDITION_UNKNOWN, "cannot find the table");
		if (located.value._tag === "Refused") {
			return refuse(located.value.code, located.value.reason);
		}
		const {project} = located.value;
		const dayField = project.fields.find((field) => field.name === FIELD.tableDay);
		if (dayField?._tag !== "Plain" || dayField.dataType !== "DATE") {
			return refuse(
				NOT_SET_UP,
				`${VERB}: project #${project.number} lacks the date field ${FIELD.tableDay} — run \`fabrika table setup\` first. Nothing was written.`,
			);
		}
		const history = yield* board.week(project.id);
		if (history._tag !== "Ok") {
			return failed(history, PRECONDITION_UNKNOWN, `cannot read the ${LEGACY_WEEK} field`);
		}
		const where = `project #${project.number} "${project.title}" (${project.url})`;
		if (history.value === null) {
			return answer(
				`${JSON.stringify({answer: "unchanged", repo, project: {number: project.number, title: project.title, url: project.url}, dated: [], unresolved: []})}\n`,
				[
					`${VERB}: ${where} has no ${LEGACY_WEEK} iteration field, so there is nothing to migrate.`,
					`${VERB}: nothing was written.`,
				],
			);
		}
		const weeks = history.value;

		const items = yield* board.items(project.id);
		if (items._tag !== "Ok") return failed(items, PRECONDITION_UNKNOWN, "cannot read the rows");
		const {dating, unresolved} = planMigration(items.value, weeks);

		const landed: Dating[] = [];
		for (const one of dating) {
			const set = yield* board.set(
				{projectId: project.id, itemId: one.itemId, fieldId: dayField.id},
				{_tag: "Date", date: one.tableDay},
			);
			if (set._tag !== "Ok") {
				const so = landed.length > 0 ? ` after dating ${landed.map(itemName).join(", ")}` : "";
				return failed(
					set,
					WRITE_UNKNOWN,
					`dating ${itemName(one)} ${one.tableDay} did not land — UNKNOWN${so}; re-run the migration to finish`,
				);
			}
			landed.push(one);
		}

		if (landed.length > 0) {
			const back = yield* board.items(project.id);
			if (back._tag !== "Ok") {
				return failed(
					back,
					READBACK_MISMATCH,
					`dated ${landed.length} row(s) and could not re-read the rows`,
				);
			}
			const settled = planMigration(back.value, weeks).dating;
			if (settled.length > 0) {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: dated ${landed.length} row(s) and ${settled.map(itemName).join(", ")} still read undated — re-read the project before retrying.`,
				);
			}
		}

		return answer(
			`${JSON.stringify({
				answer: landed.length > 0 ? "migrated" : "unchanged",
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				dated: landed.map((one) => ({issue: one.issue, tableDay: one.tableDay})),
				unresolved: unresolved.map((one) => ({issue: one.issue, iteration: one.iteration})),
			})}\n`,
			[
				`${VERB}: read ${settings.note}.`,
				`${VERB}: ${where}; copying each row's ${LEGACY_WEEK} start date into ${FIELD.tableDay}. The ${LEGACY_WEEK} field is read, never written.`,
				...landed.map(
					(one) => `${VERB}: set ${itemName(one)} ${FIELD.tableDay} to ${one.tableDay}.`,
				),
				...unresolved.map(
					(one) =>
						`${VERB}: ${itemName(one)} sits in the ${LEGACY_WEEK} iteration "${one.iteration}", which the field no longer lists; it was left undated.`,
				),
				...(landed.length === 0
					? [`${VERB}: every row with a ${LEGACY_WEEK} is already dated; nothing was written.`]
					: []),
			],
		);
	});

/** The shipped board: GitHub, under the ambient token. */
export const migrateBoard: MigrateBoard<ChildProcessSpawner.ChildProcessSpawner> = {
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: syncBoard.items,
	set: syncBoard.set,
	week: (projectId) => withProjects((token) => readIterationHistory(token, projectId, LEGACY_WEEK)),
};
