/**
 * `machineryLaps` — the shipped surface is today's machine, and a value nobody meant is refused
 * rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {machineryLapsKey, SHIPPED_MACHINERY_LAPS} from "./machinery-laps.ts";

describe("the machineryLaps key", () => {
	it("ships off, so a repo declaring nothing emits the machine it has today", () => {
		expect(SHIPPED_MACHINERY_LAPS).toEqual({onEmit: "off"});
		expect(machineryLapsKey.shippedDefault).toEqual(SHIPPED_MACHINERY_LAPS);
	});

	it.each(["off", "on"])("decodes the declared %s", (onEmit) => {
		expect(machineryLapsKey.decode({onEmit})).toEqual({_tag: "Value", value: {onEmit}});
	});

	it("falls to the shipped value for an object that declares no sub-key", () => {
		expect(machineryLapsKey.decode({})).toEqual({_tag: "Value", value: SHIPPED_MACHINERY_LAPS});
	});

	it.each([
		["a value outside the two arms", {onEmit: "sometimes"}],
		["a boolean where a token belongs", {onEmit: true}],
		["a sub-key nobody reads", {onEmmit: "on"}],
		["a scalar where the surface belongs", "on"],
		["an array where the surface belongs", ["on"]],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(machineryLapsKey.decode(raw)._tag).toBe("Malformed");
	});
});
