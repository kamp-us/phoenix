/**
 * The table's `bet` rows, each with the issues it stands for: what pitch-guard's bet arm reads.
 *
 * A row counts once its Stage is `bet`, in any iteration: the yes was said, and a later week does
 * not take it back. Who set the Stage is carried as GitHub reports it, and the size as the Size cell
 * names it; judging either is pitch-guard's, not this module's.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9913
 */

import type {ProjectItem} from "../io/projects.ts";
import {BET_STAGE} from "./bets.ts";
import {type GroupKind, groupOf, type IssueGraph, issuesOf, kindOf} from "./group.ts";
import {FIELD} from "./shape.ts";

/** One `bet` cell off the table, before its group is derived. */
export interface BetCell {
	readonly head: number;
	/** The Size option set on the row, or `null` when the cell is empty. */
	readonly size: string | null;
	/** Who set the Stage to `bet`, or `null` when GitHub names no actor. */
	readonly setter: string | null;
}

/** A `bet` row with the issues it stands for. */
export interface BetRow extends BetCell {
	/** `epic` or `chain` for a group row, `null` for a row that stands for its issue alone. */
	readonly kind: GroupKind | null;
	/** The head first, then every member. */
	readonly covers: ReadonlyArray<number>;
}

const option = (item: ProjectItem, field: string) =>
	item.values.find((value) => value.fieldName === field && value.value._tag === "Option");

const optionName = (item: ProjectItem, field: string): string | null => {
	const cell = option(item, field)?.value;
	return cell?._tag === "Option" ? cell.name : null;
};

/** Every row of `repo`'s issues whose Stage is `bet`. */
export const betCellsOf = (
	items: ReadonlyArray<ProjectItem>,
	repo: string,
): ReadonlyArray<BetCell> =>
	items.flatMap((item) => {
		if (item.contentType !== "Issue" || item.repository !== repo || item.contentNumber === null) {
			return [];
		}
		if (optionName(item, FIELD.stage) !== BET_STAGE) return [];
		return [
			{
				head: item.contentNumber,
				size: optionName(item, FIELD.size),
				setter: option(item, FIELD.stage)?.creator ?? null,
			},
		];
	});

export type BetRows =
	| {readonly _tag: "Derived"; readonly rows: ReadonlyArray<BetRow>}
	/** The graph lacks these nodes, so some row's group is not decidable yet. */
	| {readonly _tag: "Incomplete"; readonly missing: ReadonlyArray<number>};

/** Each cell's group, through the one membership module, so no reader disagrees with sync. */
export const betRowsOf = (cells: ReadonlyArray<BetCell>, graph: IssueGraph): BetRows => {
	const rows: BetRow[] = [];
	const missing = new Set<number>();
	const bets = new Set(cells.map((cell) => cell.head));
	for (const cell of cells) {
		const membership = groupOf(cell.head, graph, bets);
		if (membership._tag === "Incomplete") {
			for (const issue of membership.missing) missing.add(issue);
			continue;
		}
		rows.push({...cell, kind: kindOf(membership.group), covers: issuesOf(membership.group)});
	}
	return missing.size > 0
		? {_tag: "Incomplete", missing: [...missing].sort((a, b) => a - b)}
		: {_tag: "Derived", rows};
};
