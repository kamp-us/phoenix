/**
 * `assemblyReplay` — the shipped surface is today's refusal, and a value nobody meant is refused
 * rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {assemblyReplayKey, SHIPPED_ASSEMBLY_REPLAY} from "./assembly-replay.ts";

describe("the assemblyReplay key", () => {
	it("ships off, so a repo declaring nothing keeps the collision refusal it has today", () => {
		expect(SHIPPED_ASSEMBLY_REPLAY).toEqual({onCollision: "off"});
		expect(assemblyReplayKey.shippedDefault).toEqual(SHIPPED_ASSEMBLY_REPLAY);
	});

	it.each(["off", "on"])("decodes the declared %s", (onCollision) => {
		expect(assemblyReplayKey.decode({onCollision})).toEqual({
			_tag: "Value",
			value: {onCollision},
		});
	});

	it("falls to the shipped value for an object that declares no sub-key", () => {
		expect(assemblyReplayKey.decode({})).toEqual({
			_tag: "Value",
			value: SHIPPED_ASSEMBLY_REPLAY,
		});
	});

	it.each([
		["a value outside the two arms", {onCollision: "sometimes"}],
		["a boolean where a token belongs", {onCollision: true}],
		["a sub-key nobody reads", {onColision: "on"}],
		["a scalar where the surface belongs", "on"],
		["an array where the surface belongs", ["on"]],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(assemblyReplayKey.decode(raw)._tag).toBe("Malformed");
	});
});
