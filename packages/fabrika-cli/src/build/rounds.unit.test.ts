import {describe, expect, it} from "vitest";
import {countRounds, ROUND_GAP_MS} from "./rounds.ts";

const at = (secondsFromStart: number) =>
	new Date(1_770_000_000_000 + secondsFromStart * 1000).toISOString();

describe("countRounds clusters FAIL markers by the 120-second gap rule", () => {
	it("counts no FAILs as zero rounds — a fact, not a gap", () => {
		expect(countRounds([])).toBe(0);
	});

	it("folds a burst of markers seconds apart into one round", () => {
		expect(countRounds([at(0), at(3), at(9)])).toBe(1);
	});

	/**
	 * The boundary is the whole point of pinning the rule: 120 seconds *continues* the round and 121
	 * starts a new one. Off by one here is #4570, and it decides whether the cap has been reached.
	 */
	it("continues the round at EXACTLY 120 seconds and starts a new one at 121", () => {
		expect(ROUND_GAP_MS).toBe(120_000);
		expect(countRounds([at(0), at(120)])).toBe(1);
		expect(countRounds([at(0), at(121)])).toBe(2);
	});

	it("counts three separated markers as three rounds", () => {
		expect(countRounds([at(0), at(300), at(600)])).toBe(3);
	});

	it("sorts before clustering, so an out-of-order list counts the same", () => {
		expect(countRounds([at(600), at(0), at(300)])).toBe(3);
	});

	it("ignores an unparseable timestamp rather than treating it as time zero", () => {
		expect(countRounds(["not a date", at(0), at(3)])).toBe(1);
	});
});
