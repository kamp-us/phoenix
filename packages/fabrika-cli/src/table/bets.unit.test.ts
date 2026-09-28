import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import type {Board, BoardItem} from "../io/projects.ts";
import {BET_STAGE, betOrder, betsFirst} from "./bets.ts";
import {STAGES} from "./shape.ts";

/** A Wednesday; the shipped table meets on Mondays, so the table in force is Monday Sep 28. */
const NOW = new Date("2026-09-30T12:00:00Z");
const THIS_TABLE = "2026-09-28";
const LAST_TABLE = "2026-09-21";
const NEXT_TABLE = "2026-10-05";
const SETTINGS = {
	...SHIPPED_TABLE,
	sections: ["Tails", "Customers", "New bets", "Outside the bets"],
};

const item = (over: Partial<BoardItem> & {readonly issue: number | null}): BoardItem => ({
	archived: false,
	stage: BET_STAGE,
	section: "New bets",
	tableDay: THIS_TABLE,
	...over,
});

const board = (...items: ReadonlyArray<BoardItem>): Board => ({items});

describe("betOrder", () => {
	it("names the Stage option the table's own shape offers", () => {
		expect(STAGES.map((stage) => stage.name)).toContain(BET_STAGE);
	});

	it("counts a bet dated the current table, and not one dated a past or a future table", () => {
		const order = betOrder(
			board(
				item({issue: 1}),
				item({issue: 2, stage: "proposed"}),
				item({issue: 3, tableDay: NEXT_TABLE}),
				item({issue: 4, tableDay: null}),
				item({issue: null}),
				item({issue: 5, archived: true}),
				item({issue: 6, tableDay: LAST_TABLE}),
			),
			SETTINGS,
			NOW,
		);
		expect(order).toEqual({tableDay: THIS_TABLE, issues: [1]});
	});

	it("reads the table in force as the table day on or before today, the day itself included", () => {
		expect(betOrder(board(), SETTINGS, new Date("2026-09-28T00:00:00Z")).tableDay).toBe(THIS_TABLE);
		expect(betOrder(board(), SETTINGS, new Date("2026-10-04T23:59:00Z")).tableDay).toBe(THIS_TABLE);
		expect(betOrder(board(), SETTINGS, new Date("2026-10-05T00:00:00Z")).tableDay).toBe(NEXT_TABLE);
	});

	it("orders bets by section in agenda order, then by the project's own item order", () => {
		const order = betOrder(
			board(
				item({issue: 10, section: "New bets"}),
				item({issue: 11, section: "Customers"}),
				item({issue: 12, section: "Tails"}),
				item({issue: 13, section: "Customers"}),
			),
			SETTINGS,
			NOW,
		);
		expect(order.issues).toEqual([12, 11, 13, 10]);
	});

	it("puts a bet with no section or an unknown one after every listed section, never dropping it", () => {
		const order = betOrder(
			board(item({issue: 20, section: null}), item({issue: 21, section: "Tails"})),
			SETTINGS,
			NOW,
		);
		expect(order.issues).toEqual([21, 20]);
	});

	it("answers no bets when no row is dated the table in force", () => {
		const late = new Date("2026-11-30T12:00:00Z");
		expect(betOrder(board(item({issue: 1})), SETTINGS, late)).toEqual({
			tableDay: "2026-11-30",
			issues: [],
		});
	});
});

describe("betsFirst", () => {
	const pool = [{number: 5}, {number: 6}, {number: 7}, {number: 8}];

	it("moves bets to the front in bet order and keeps everything else in place", () => {
		expect(betsFirst(pool, [7, 5]).map((entry) => entry.number)).toEqual([7, 5, 6, 8]);
	});

	it("leaves the pool untouched when nothing is bet on", () => {
		expect(betsFirst(pool, [])).toEqual(pool);
	});

	it("never adds a bet the pool left out", () => {
		expect(betsFirst(pool, [99, 6]).map((entry) => entry.number)).toEqual([6, 5, 7, 8]);
	});
});
