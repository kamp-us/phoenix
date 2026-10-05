/**
 * `baseRedLaps` — ships 2, and a value nobody meant is refused rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {baseRedLapsKey, SHIPPED_BASE_RED_LAPS} from "./base-red-laps.ts";

describe("the baseRedLaps key", () => {
	it("ships 2, so a repo declaring nothing gets two free laps on a red base", () => {
		expect(SHIPPED_BASE_RED_LAPS).toBe(2);
		expect(baseRedLapsKey.shippedDefault).toBe(2);
	});

	it.each([0, 1, 5])("decodes the declared %s", (laps) => {
		expect(baseRedLapsKey.decode(laps)).toEqual({_tag: "Value", value: laps});
	});

	it.each([
		["a negative count", -1],
		["a fraction", 1.5],
		["a numeric string", "2"],
		["null", null],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(baseRedLapsKey.decode(raw)._tag).toBe("Malformed");
	});
});
