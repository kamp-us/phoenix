import {describe, expect, it} from "vitest";
import {capAndCount, reasonHistogram} from "./evidence.ts";

const row = (reason: string, number: number) => ({number, reason});

describe("reasonHistogram", () => {
	it("tallies nothing to an empty object", () => {
		expect(reasonHistogram([], (entry: {reason: string}) => entry.reason)).toEqual({});
	});

	it("tallies one row to one reason at one", () => {
		expect(reasonHistogram([row("out-of-focus", 1)], (entry) => entry.reason)).toEqual({
			"out-of-focus": 1,
		});
	});

	it("tallies many rows by reason", () => {
		const rows = [
			...Array.from({length: 155}, (_, index) => row("audience-not-agent", index)),
			...Array.from({length: 111}, (_, index) => row("out-of-focus", index)),
		];

		expect(reasonHistogram(rows, (entry) => entry.reason)).toEqual({
			"audience-not-agent": 155,
			"out-of-focus": 111,
		});
	});

	it("orders keys count-descending, so the serialized bytes do not follow the row order", () => {
		const rows = [row("blocked", 1), row("unreadable", 2), row("blocked", 3), row("blocked", 4)];

		expect(Object.keys(reasonHistogram(rows, (entry) => entry.reason))).toEqual([
			"blocked",
			"unreadable",
		]);
	});

	it("breaks a count tie on the reason, so two orderings of the same rows print the same bytes", () => {
		const forward = [row("out-of-focus", 1), row("audience-not-agent", 2)];
		const reversed = [...forward].reverse();

		expect(JSON.stringify(reasonHistogram(forward, (entry) => entry.reason))).toEqual(
			JSON.stringify(reasonHistogram(reversed, (entry) => entry.reason)),
		);
		expect(Object.keys(reasonHistogram(reversed, (entry) => entry.reason))).toEqual([
			"audience-not-agent",
			"out-of-focus",
		]);
	});

	it("reads the reason off any iterable, not only an array", () => {
		expect(reasonHistogram(new Set(["a", "b", "a"]), (reason) => reason)).toEqual({a: 1, b: 1});
	});
});

describe("capAndCount", () => {
	it("keeps nothing and counts nothing when there are no rows", () => {
		expect(capAndCount([], 3)).toEqual({rows: [], more: 0});
	});

	it("keeps every row below the cap and reports no remainder", () => {
		expect(capAndCount([1, 2], 3)).toEqual({rows: [1, 2], more: 0});
	});

	it("keeps every row at the cap and still reports the remainder as zero", () => {
		expect(capAndCount([1, 2, 3], 3)).toEqual({rows: [1, 2, 3], more: 0});
	});

	it("keeps the first cap rows above the cap and counts the rest", () => {
		expect(capAndCount([1, 2, 3, 4, 5], 3)).toEqual({rows: [1, 2, 3], more: 2});
	});

	it("keeps nothing on a cap that is not a whole number above zero", () => {
		for (const cap of [0, -1, 1.5, Number.NaN]) {
			expect(capAndCount([1, 2, 3], cap)).toEqual({rows: [], more: 3});
		}
	});

	it("does not mutate the rows it was handed", () => {
		const rows = [1, 2, 3];
		capAndCount(rows, 1);
		expect(rows).toEqual([1, 2, 3]);
	});
});
