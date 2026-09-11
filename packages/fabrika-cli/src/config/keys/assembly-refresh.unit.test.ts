/**
 * `assemblyRefresh` — the shipped surface is today's path into review, and a value nobody meant is
 * refused rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {assemblyRefreshKey, SHIPPED_ASSEMBLY_REFRESH} from "./assembly-refresh.ts";

describe("the assemblyRefresh key", () => {
	it("ships both arms off, so a repo declaring nothing keeps the paths it has today", () => {
		expect(SHIPPED_ASSEMBLY_REFRESH).toEqual({onReview: "off", onDispatch: "off"});
		expect(assemblyRefreshKey.shippedDefault).toEqual(SHIPPED_ASSEMBLY_REFRESH);
	});

	it.each(["off", "on"])("decodes the declared onReview %s", (onReview) => {
		expect(assemblyRefreshKey.decode({onReview})).toEqual({
			_tag: "Value",
			value: {onReview, onDispatch: SHIPPED_ASSEMBLY_REFRESH.onDispatch},
		});
	});

	it.each(["off", "on"])("decodes the declared onDispatch %s", (onDispatch) => {
		expect(assemblyRefreshKey.decode({onDispatch})).toEqual({
			_tag: "Value",
			value: {onReview: SHIPPED_ASSEMBLY_REFRESH.onReview, onDispatch},
		});
	});

	it("reads the two arms independently — one declared on leaves the other shipped", () => {
		expect(assemblyRefreshKey.decode({onDispatch: "on"})).toEqual({
			_tag: "Value",
			value: {onReview: "off", onDispatch: "on"},
		});
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
		["a dispatch arm outside the two values", {onDispatch: "later"}],
		["a sub-key nobody reads", {onReviw: "on"}],
		["a scalar where the surface belongs", "on"],
		["an array where the surface belongs", ["on"]],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(assemblyRefreshKey.decode(raw)._tag).toBe("Malformed");
	});
});
