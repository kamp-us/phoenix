/**
 * `assemblyRefresh` — the shipped surface is today's path into review, and a value nobody meant is
 * refused rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {assemblyRefreshKey, SHIPPED_ASSEMBLY_REFRESH} from "./assembly-refresh.ts";

describe("the assemblyRefresh key", () => {
	it("ships off, so a repo declaring nothing keeps the path into review it has today", () => {
		expect(SHIPPED_ASSEMBLY_REFRESH).toEqual({onReview: "off"});
		expect(assemblyRefreshKey.shippedDefault).toEqual(SHIPPED_ASSEMBLY_REFRESH);
	});

	it.each(["off", "on"])("decodes the declared %s", (onReview) => {
		expect(assemblyRefreshKey.decode({onReview})).toEqual({_tag: "Value", value: {onReview}});
	});

	it("falls to the shipped value for an object that declares no sub-key", () => {
		expect(assemblyRefreshKey.decode({})).toEqual({
			_tag: "Value",
			value: SHIPPED_ASSEMBLY_REFRESH,
		});
	});

	it.each([
		["a value outside the two arms", {onReview: "sometimes"}],
		["a boolean where a token belongs", {onReview: true}],
		["a sub-key nobody reads", {onReviw: "on"}],
		["a scalar where the surface belongs", "on"],
		["an array where the surface belongs", ["on"]],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(assemblyRefreshKey.decode(raw)._tag).toBe("Malformed");
	});
});
