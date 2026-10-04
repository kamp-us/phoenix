import {describe, expect, it} from "vitest";
import {rulingSince} from "./ruling-read.ts";

const PARKED = "2026-08-16T00:01:00.000Z";
const BEFORE = "2026-08-15T23:00:00Z";
const AFTER = "2026-08-20T05:11:02Z";

const answer = (state: unknown, at: unknown): string =>
	JSON.stringify({answer: "ruling", issue: 4300, state, at});

describe("rulingSince", () => {
	it.each([
		"current",
		"stale",
	] as const)("reads a %s marker dated after the park as made", (state) => {
		expect(rulingSince(answer(state, AFTER), PARKED)).toEqual({_tag: "Made", state, at: AFTER});
	});

	// An issue can already carry a ruling when its lane parks, and that ruling is not the one the
	// park waits on — a marker alone would clear the park the moment it was recorded.
	it.each([
		["dated before the park", BEFORE],
		["dated the instant of the park", PARKED],
	])("holds on a marker %s", (_name, at) => {
		expect(rulingSince(answer("current", at), PARKED)._tag).toBe("Holds");
	});

	it("holds while no marker stands, though the verb exited 0", () => {
		expect(rulingSince(answer("absent", null), PARKED)._tag).toBe("Holds");
	});

	it.each([
		["an answer that is not JSON", "decision ruling: cannot read", PARKED],
		["an answer with no state", JSON.stringify({answer: "ruling"}), PARKED],
		["a state outside the three", answer("pending", AFTER), PARKED],
		["a standing marker with no time", answer("current", null), PARKED],
		["a standing marker whose time does not parse", answer("stale", "last Thursday"), PARKED],
		["a park line with no time", answer("current", AFTER), null],
	])("is unreadable, never made, on %s", (_name, stdout, parkedAt) => {
		expect(rulingSince(stdout, parkedAt)._tag).toBe("Unreadable");
	});
});
