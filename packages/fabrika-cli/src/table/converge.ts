/**
 * Apply one plan of row writes to a project until its rows read in step, the way `table prep` and
 * `table route` both write: adds first, the rows re-read so each new item has an id, then the cells,
 * then a last read whose plan must be empty. That empty last plan is the read-back, and it is also
 * what makes a second run write nothing.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10302
 */

import {Effect} from "effect";
import type {ProjectSnapshot, ProjectsAnswer} from "../io/projects.ts";
import {describePrepWrite, type PrepWrite} from "./agenda.ts";
import {READBACK_MISMATCH, SCOPE_MISSING, WRITE_UNKNOWN} from "./codes.ts";
import type {Row} from "./sync.ts";
import {type Refusal, rowsOf, type SyncBoard} from "./sync-verb.ts";

/** The board acts a converge takes: the rows, and the four writes a plan holds. */
export interface ConvergeBoard<R> extends Pick<SyncBoard<R>, "items" | "add" | "set" | "clear"> {
	readonly remove: (
		projectId: string,
		itemId: string,
	) => Effect.Effect<ProjectsAnswer<string>, never, R>;
}

const refused = (code: number, reason: string): Refusal => ({_tag: "Refused", code, reason});

export const stopOnWrite = (
	verb: string,
	failed: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
	onFailure: number,
	what: string,
): Refusal =>
	failed._tag === "MissingScope"
		? refused(SCOPE_MISSING, `${verb}: ${failed.reason}.`)
		: refused(onFailure, `${verb}: ${what}: ${failed.reason}.`);

const applyAll = <R>(
	verb: string,
	board: ConvergeBoard<R>,
	project: ProjectSnapshot,
	repo: string,
	writes: ReadonlyArray<PrepWrite>,
	landed: string[],
	describe: (write: PrepWrite) => string,
): Effect.Effect<Refusal | null, never, R> =>
	Effect.gen(function* () {
		for (const write of writes) {
			let done: ProjectsAnswer<string>;
			switch (write._tag) {
				case "Add":
					done = yield* board.add(project.id, repo, write.issue);
					break;
				case "Set":
					done = yield* board.set(
						{projectId: project.id, itemId: write.itemId, fieldId: write.fieldId},
						write.value,
					);
					break;
				case "Clear":
					done = yield* board.clear({
						projectId: project.id,
						itemId: write.itemId,
						fieldId: write.fieldId,
					});
					break;
				case "Delete":
					done = yield* board.remove(project.id, write.itemId);
					break;
			}
			if (done._tag !== "Ok") {
				const so = landed.length > 0 ? ` after: ${landed.join("; ")}` : "";
				return stopOnWrite(
					verb,
					done,
					WRITE_UNKNOWN,
					`${describe(write)} did not land — UNKNOWN${so}; re-run ${verb} to finish`,
				);
			}
			landed.push(describe(write));
		}
		return null;
	});

export type Converged = {readonly _tag: "Converged"; readonly changes: ReadonlyArray<string>};

/** Apply `plan` until the rows read in step. `where` names the board in what the run reports. */
export const converge = <R>(
	verb: string,
	board: ConvergeBoard<R>,
	project: ProjectSnapshot,
	repo: string,
	first: ReadonlyMap<number, Row>,
	plan: (rows: ReadonlyMap<number, Row>) => ReadonlyArray<PrepWrite>,
	where = "the table",
): Effect.Effect<Converged | Refusal, never, R> =>
	Effect.gen(function* () {
		const describe = (write: PrepWrite): string => describePrepWrite(write, where);
		const landed: string[] = [];
		const readRows = Effect.map(
			board.items(project.id),
			(items): ProjectsAnswer<ReadonlyMap<number, Row>> =>
				items._tag === "Ok" ? {_tag: "Ok", value: rowsOf(items.value, repo)} : items,
		);

		const adds = plan(first).filter((write) => write._tag === "Add");
		const addFailed = yield* applyAll(verb, board, project, repo, adds, landed, describe);
		if (addFailed !== null) return addFailed;

		let rows: ReadonlyMap<number, Row> = first;
		if (adds.length > 0) {
			const read = yield* readRows;
			if (read._tag !== "Ok") {
				return stopOnWrite(
					verb,
					read,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			rows = read.value;
		}
		const values = plan(rows);
		const stray = values.filter((write) => write._tag === "Add");
		if (stray.length > 0) {
			return refused(
				READBACK_MISMATCH,
				`${verb}: wrote ${landed.join("; ")} and ${stray.map((write) => `#${write.issue}`).join(", ")} still does not read as a row — re-read the project before retrying.`,
			);
		}
		const valuesFailed = yield* applyAll(verb, board, project, repo, values, landed, describe);
		if (valuesFailed !== null) return valuesFailed;

		if (landed.length > 0) {
			const read = yield* readRows;
			if (read._tag !== "Ok") {
				return stopOnWrite(
					verb,
					read,
					READBACK_MISMATCH,
					`wrote ${landed.join("; ")} and could not re-read the rows`,
				);
			}
			const settled = plan(read.value);
			if (settled.length > 0) {
				return refused(
					READBACK_MISMATCH,
					`${verb}: wrote ${landed.join("; ")} and the rows still do not read in step: ${settled.map(describe).join("; ")} — re-read the project before retrying.`,
				);
			}
		}
		return {_tag: "Converged", changes: landed};
	});
