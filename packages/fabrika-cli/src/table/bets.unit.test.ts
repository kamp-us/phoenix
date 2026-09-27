import {describe, expect, it} from "vitest";
import type {Board, BoardItem} from "../io/projects.ts";
import {BET_STAGE, betOrder, betsFirst, currentIteration} from "./bets.ts";
import {STAGES} from "./shape.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const THIS_WEEK = {id: "it-this", title: "Week of Sep 28", startDate: "2026-09-28", duration: 7};
const NEXT_WEEK = {id: "it-next", title: "Week of Oct 5", startDate: "2026-10-05", duration: 7};
const SECTIONS = ["Tails", "Customers", "New bets", "Outside the bets"];

const item = (over: Partial<BoardItem> & {readonly issue: number | null}): BoardItem => ({
	archived: false,
	stage: BET_STAGE,
	section: "New bets",
	iterationId: THIS_WEEK.id,
	...over,
});

const board = (...items: ReadonlyArray<BoardItem>): Board => ({
	items,
	iterations: [THIS_WEEK, NEXT_WEEK],
});

describe("currentIteration", () => {
	it("finds the iteration now falls in, start day inclusive and end day exclusive", () => {
		expect(currentIteration([THIS_WEEK, NEXT_WEEK], NOW)).toEqual(THIS_WEEK);
		expect(currentIteration([THIS_WEEK], new Date("2026-09-28T00:00:00Z"))).toEqual(THIS_WEEK);
		expect(currentIteration([THIS_WEEK], new Date("2026-10-05T00:00:00Z"))).toBeNull();
	});
});

describe("betOrder", () => {
	it("names the Stage option the table's own shape offers", () => {
		expect(STAGES.map((stage) => stage.name)).toContain(BET_STAGE);
	});

	it("keeps only bets in the current iteration", () => {
		const order = betOrder(
			board(
				item({issue: 1}),
				item({issue: 2, stage: "proposed"}),
				item({issue: 3, iterationId: NEXT_WEEK.id}),
				item({issue: 4, iterationId: null}),
				item({issue: null}),
				item({issue: 5, archived: true}),
			),
			SECTIONS,
			NOW,
		);
		expect(order).toEqual({iteration: THIS_WEEK, issues: [1]});
	});

	it("orders bets by section in agenda order, then by the project's own item order", () => {
		const order = betOrder(
			board(
				item({issue: 10, section: "New bets"}),
				item({issue: 11, section: "Customers"}),
				item({issue: 12, section: "Tails"}),
				item({issue: 13, section: "Customers"}),
			),
			SECTIONS,
			NOW,
		);
		expect(order.issues).toEqual([12, 11, 13, 10]);
	});

	it("puts a bet with no section or an unknown one after every listed section, never dropping it", () => {
		const order = betOrder(
			board(item({issue: 20, section: null}), item({issue: 21, section: "Tails"})),
			SECTIONS,
			NOW,
		);
		expect(order.issues).toEqual([21, 20]);
	});

	it("answers no bets when no iteration is current, or the project has no iteration field", () => {
		const late = new Date("2026-11-30T12:00:00Z");
		expect(betOrder(board(item({issue: 1})), SECTIONS, late)).toEqual({
			iteration: null,
			issues: [],
		});
		expect(betOrder({items: [item({issue: 1})], iterations: null}, SECTIONS, NOW).issues).toEqual(
			[],
		);
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
