/**
 * The bet order: the issues the table said yes to at the table in force, in agenda order. It is
 * what `build pick` offers ahead of everything else, and it is only an order: an issue the table did
 * not bet on is still offered, after the bets.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import type {TableSettings} from "../config/keys/table.ts";
import type {Board, BoardItem} from "../io/projects.ts";
import {currentTableDay, type TableDay} from "./table-day.ts";

/** The Stage option a yes at the table sets. */
export const BET_STAGE = "bet";

export interface BetOrder {
	/** The table the bets were read for: the table day on or before today. */
	readonly tableDay: TableDay;
	/** Bet issues in agenda order, each once. */
	readonly issues: ReadonlyArray<number>;
}

/** A bet at the table on `day`: Stage `bet`, dated that day. A bet dated any other day is not. */
export const isBetAt =
	(day: TableDay) =>
	(item: BoardItem): item is BoardItem & {readonly issue: number} =>
		!item.archived && item.issue !== null && item.stage === BET_STAGE && item.tableDay === day;

/**
 * Bets in agenda order: by section, in the order `sections` lists them, and in the project's own
 * item order inside a section. A bet whose section is empty or not on the list comes after every
 * listed one, so a mistyped section never hides a bet.
 */
export const betOrder = (
	board: Board,
	settings: Pick<TableSettings, "day" | "timeZone" | "sections">,
	now: Date,
): BetOrder => {
	const tableDay = currentTableDay(settings, now);
	const {sections} = settings;
	const rank = (section: string | null): number => {
		const index = section === null ? -1 : sections.indexOf(section);
		return index === -1 ? sections.length : index;
	};
	const bets = board.items
		.filter(isBetAt(tableDay))
		.map((item, position) => ({item, position}))
		.sort((a, b) => rank(a.item.section) - rank(b.item.section) || a.position - b.position);
	return {tableDay, issues: [...new Set(bets.map(({item}) => item.issue))]};
};

/**
 * The pool with its bets moved to the front, in bet order, and everything else behind them in the
 * order it already had. Only candidates already in the pool move: a bet the pool left out stays out.
 */
export const betsFirst = <A extends {readonly number: number}>(
	pool: ReadonlyArray<A>,
	bets: ReadonlyArray<number>,
): ReadonlyArray<A> => {
	const rank = new Map(bets.map((issue, index) => [issue, index]));
	const placed = (entry: A): number => rank.get(entry.number) ?? bets.length;
	return [
		...pool.filter((entry) => rank.has(entry.number)).sort((a, b) => placed(a) - placed(b)),
		...pool.filter((entry) => !rank.has(entry.number)),
	];
};
