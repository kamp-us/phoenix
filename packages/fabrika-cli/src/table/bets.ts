/**
 * The bet order: the issues the table said yes to for the current iteration, in agenda order. It is
 * what `build pick` offers ahead of everything else, and it is only an order: an issue the table did
 * not bet on is still offered, after the bets.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {Board, BoardItem, BoardIteration} from "../io/projects.ts";

/** The Stage option a yes at the table sets. */
export const BET_STAGE = "bet";

const DAY_MS = 86_400_000;

/**
 * The iteration `now` falls in, or `null` when none does — a table that has not met for a while, or
 * an iteration field whose first iteration starts later.
 */
export const currentIteration = (
	iterations: ReadonlyArray<BoardIteration>,
	now: Date,
): BoardIteration | null =>
	iterations.find((iteration) => {
		const start = Date.parse(`${iteration.startDate}T00:00:00Z`);
		return start <= now.getTime() && now.getTime() < start + iteration.duration * DAY_MS;
	}) ?? null;

export interface BetOrder {
	/** The iteration the bets were read for, or `null` when the project names no current one. */
	readonly iteration: BoardIteration | null;
	/** Bet issues in agenda order, each once. Empty with no current iteration. */
	readonly issues: ReadonlyArray<number>;
}

const isBetIn =
	(iteration: BoardIteration) =>
	(item: BoardItem): item is BoardItem & {readonly issue: number} =>
		!item.archived &&
		item.issue !== null &&
		item.stage === BET_STAGE &&
		item.iterationId === iteration.id;

/**
 * Bets in agenda order: by section, in the order `sections` lists them, and in the project's own
 * item order inside a section. A bet whose section is empty or not on the list comes after every
 * listed one, so a mistyped section never hides a bet.
 */
export const betOrder = (board: Board, sections: ReadonlyArray<string>, now: Date): BetOrder => {
	const iteration = board.iterations === null ? null : currentIteration(board.iterations, now);
	if (iteration === null) return {iteration: null, issues: []};
	const rank = (section: string | null): number => {
		const index = section === null ? -1 : sections.indexOf(section);
		return index === -1 ? sections.length : index;
	};
	const bets = board.items
		.filter(isBetIn(iteration))
		.map((item, position) => ({item, position}))
		.sort((a, b) => rank(a.item.section) - rank(b.item.section) || a.position - b.position);
	return {iteration, issues: [...new Set(bets.map(({item}) => item.issue))]};
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
