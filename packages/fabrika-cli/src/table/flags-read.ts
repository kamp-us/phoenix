/**
 * Read the table's rows as the flags judge them: each group row with its Stage, Size and members,
 * and every lane record on the issues it stands for.
 *
 * The rows, the graph and the records come through the same reads `table sync` makes, so a flag and
 * the Spent $ column sync writes are sums over one set of lanes.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect} from "effect";
import type {TableSettings} from "../config/keys/table.ts";
import type {ProjectSnapshot, ProjectsAnswer} from "../io/projects.ts";
import type {LaneRecord} from "../wire/lane-record.ts";
import {PRECONDITION_UNKNOWN, SCOPE_MISSING} from "./codes.ts";
import {type HeadRow, type StageCell, sizeOf} from "./flags.ts";
import {membersOf} from "./group.ts";
import {FIELD} from "./shape.ts";
import type {Row, SyncNode} from "./sync.ts";
import {type Refusal, readRecords, readScope, rowsOf, type TableBoard} from "./sync-verb.ts";

export interface Heads {
	readonly _tag: "Heads";
	readonly project: ProjectSnapshot;
	readonly rows: ReadonlyArray<HeadRow>;
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
	/** Every row of the repository's issues on the table, by issue. */
	readonly table: ReadonlyMap<number, Row>;
	/** The issue graph read to decide the rows' groups. */
	readonly graph: ReadonlyMap<number, SyncNode>;
}

const refused = (code: number, reason: string): Refusal => ({_tag: "Refused", code, reason});

export const stopOn = (
	verb: string,
	failed: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
	what: string,
): Refusal =>
	failed._tag === "MissingScope"
		? refused(SCOPE_MISSING, `${verb}: ${failed.reason}.`)
		: refused(PRECONDITION_UNKNOWN, `${verb}: ${what}: ${failed.reason}.`);

const cell = (row: Row, field: string) => row.values.find((value) => value.fieldName === field);

const optionName = (row: Row | undefined, field: string): string | null => {
	const value = row === undefined ? undefined : cell(row, field)?.value;
	return value?._tag === "Option" ? value.name : null;
};

const stageOf = (row: Row): StageCell | null => {
	const stage = cell(row, FIELD.stage);
	return stage?.value._tag === "Option"
		? {name: stage.value.name, setter: stage.creator, setAt: stage.updatedAt}
		: null;
};

/**
 * Every group row the named issues reach, or every row on the table when none is named, with the
 * lane records on the issues each stands for. A group head that is not a row carries no Stage or
 * Size, so it has nothing to be flagged on and is left out.
 */
export const readHeads = <R>(
	board: TableBoard<R>,
	verb: string,
	repo: string,
	settings: TableSettings,
	issues: ReadonlyArray<number>,
): Effect.Effect<Heads | Refusal, never, R> =>
	Effect.gen(function* () {
		const located = yield* board.locate(repo, settings);
		if (located._tag !== "Ok") return stopOn(verb, located, "cannot find the table");
		if (located.value._tag === "Refused") return located.value;
		const {project} = located.value;
		const items = yield* board.items(project.id);
		if (items._tag !== "Ok") {
			return stopOn(verb, items, `cannot read project #${project.number}'s rows`);
		}
		const rows = rowsOf(items.value, repo);
		const onTable = new Set(rows.keys());
		const seeds = issues.length > 0 ? issues : [...onTable].sort((a, b) => a - b);
		const scoped = yield* readScope(board, verb, repo, seeds, onTable);
		if (scoped._tag === "Refused") return scoped;
		const read = yield* readRecords(board, verb, repo, scoped, onTable);
		if (read._tag === "Refused") return read;
		const heads = scoped.scope.heads.flatMap((group): HeadRow[] => {
			const row = rows.get(group.head);
			if (row === undefined) return [];
			return [
				{
					group,
					stage: stageOf(row),
					size: sizeOf(optionName(row, FIELD.size)),
					children: scoped.graph.get(group.head)?.subIssues.length ?? 0,
					memberStages: membersOf(group).flatMap((member) => {
						const stage = optionName(rows.get(member), FIELD.stage);
						return stage === null ? [] : [stage];
					}),
				},
			];
		});
		return {
			_tag: "Heads",
			project,
			rows: heads,
			records: read.records,
			table: rows,
			graph: scoped.graph,
		};
	});
