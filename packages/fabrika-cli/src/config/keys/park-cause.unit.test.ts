import {describe, expect, it} from "vitest";
import {LANE_UNREADABLE} from "../../lane/codes.ts";
import {parkCauseRefusal} from "../../lane/park-cause-rule.ts";
import {PARK_CAUSES, routeUnder} from "../../lane/report.ts";
import {loadConfig, resolve} from "../load.ts";
import type {Read} from "../read-key.ts";
import {PARK_CAUSE, type ParkCauseSurface, parkCauseKey, SHIPPED_PARK_CAUSE} from "./park-cause.ts";

const declared = (config: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[PARK_CAUSE]: config})}), parkCauseKey);

const read = (value: ParkCauseSurface): Read<ParkCauseSurface> => ({
	_tag: "Value",
	value,
	note: "test",
});

describe("the shipped park-cause surface", () => {
	it("is `refuse` for a repo with no config at all, so an undeclaring repo parks only with a cause", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), parkCauseKey);

		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toEqual({
			uncaused: "refuse",
			driverRouted: "refuse",
			repairBudgetSpent: "driver",
		});
	});

	it("falls to the shipped value for a declared key that leaves the sub-key out", () => {
		const resolved = declared({});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.uncaused).toBe(SHIPPED_PARK_CAUSE.uncaused);
	});

	it.each(["record", "refuse"] as const)("takes the %s arm a repo declares for itself", (value) => {
		const resolved = declared({uncaused: value});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.uncaused).toBe(value);
	});

	// The same containment on the second axis: a repo that has not asked for driver clearances keeps
	// `recipe unpark`'s refusal exactly as it was.
	it("is `refuse` for driverRouted until a repo declares otherwise", () => {
		expect(SHIPPED_PARK_CAUSE.driverRouted).toBe("refuse");
		expect(declared({uncaused: "refuse"})).toMatchObject({value: {driverRouted: "refuse"}});
	});

	it("takes the clearing arm a repo declares, leaving the other sub-key shipped", () => {
		const resolved = declared({driverRouted: "clear"});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toEqual({
			uncaused: "refuse",
			driverRouted: "clear",
			repairBudgetSpent: "driver",
		});
	});

	// The spent-budget route keeps the one it always had until a repo declares a person should read it.
	it("routes a spent repair budget to the driver when the repo declares nothing", () => {
		expect(SHIPPED_PARK_CAUSE.repairBudgetSpent).toBe("driver");
		expect(declared({})).toMatchObject({_tag: "Declared", value: {repairBudgetSpent: "driver"}});
	});

	it.each([
		"driver",
		"founder",
	] as const)("takes the spent-budget route a repo declares (%s)", (value) => {
		const resolved = declared({repairBudgetSpent: value});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toEqual({
			uncaused: "refuse",
			driverRouted: "refuse",
			repairBudgetSpent: value,
		});
	});

	// The shipped value is the cause table's own route, so a repo declaring nothing sees no change.
	it("ships the route the repair-budget-spent cause always carried", () => {
		expect(SHIPPED_PARK_CAUSE.repairBudgetSpent).toBe(PARK_CAUSES["repair-budget-spent"].route);
	});
});

describe("an off-vocabulary or malformed value is refused at load", () => {
	it("refuses an uncaused outside record | refuse", () => {
		const resolved = declared({uncaused: "ignore"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not one of record, refuse");
	});

	it.each([null, 3, ["record"]])("refuses a non-string uncaused (%p)", (value) => {
		expect(declared({uncaused: value})._tag).toBe("Malformed");
	});

	it("refuses a driverRouted outside refuse | clear", () => {
		const resolved = declared({driverRouted: "sometimes"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not one of refuse, clear");
	});

	it("refuses a repairBudgetSpent outside driver | founder", () => {
		const resolved = declared({repairBudgetSpent: "human"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("`repairBudgetSpent` is not one of driver, founder");
	});

	it.each([null, 3, ["driver"]])("refuses a non-string repairBudgetSpent (%p)", (value) => {
		expect(declared({repairBudgetSpent: value})._tag).toBe("Malformed");
	});

	it("refuses a sub-key this module does not own, rather than dropping it", () => {
		const resolved = declared({uncausedd: "refuse"});

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not a park-cause setting");
	});

	it.each([null, "refuse", ["refuse"]])("refuses a key that is not an object (%p)", (value) => {
		expect(declared(value)._tag).toBe("Malformed");
	});
});

describe("parkCauseRefusal", () => {
	it("resolves the permissive arm to requireCause false", () => {
		expect(parkCauseRefusal("verb", read({...SHIPPED_PARK_CAUSE, uncaused: "record"}))).toEqual({
			_tag: "Resolved",
			requireCause: false,
		});
	});

	it("resolves the strict arm to requireCause true", () => {
		expect(parkCauseRefusal("verb", read({...SHIPPED_PARK_CAUSE, uncaused: "refuse"}))).toEqual({
			_tag: "Resolved",
			requireCause: true,
		});
	});

	// Never a fallback to the shipped default: that would silently restore the permissive arm in a
	// repo that declared the strict one.
	it("refuses UNKNOWN rather than falling back on a config nobody could read", () => {
		const rule = parkCauseRefusal("verb", {_tag: "Refused", reason: "EACCES"});

		expect(rule._tag).toBe("Refused");
		if (rule._tag !== "Refused") return;
		expect(rule.outcome.code).toBe(LANE_UNREADABLE);
		expect(rule.outcome.stderr.join(" ")).toContain("UNKNOWN");
		expect(rule.outcome.stderr.join(" ")).toContain("unappended");
	});
});

describe("routeUnder", () => {
	it("reads the spent-budget route off the repo's declared value", () => {
		expect(routeUnder("repair-budget-spent", {repairBudgetSpent: "driver"})).toBe("driver");
		expect(routeUnder("repair-budget-spent", {repairBudgetSpent: "founder"})).toBe("founder");
	});

	// No other cause's route is a repo's to re-declare.
	it("leaves every other cause, and a cause-less park, on the cause table's route", () => {
		expect(routeUnder("head-behind-base", {repairBudgetSpent: "founder"})).toBe("driver");
		expect(routeUnder("campaign-paused", {repairBudgetSpent: "driver"})).toBe("founder");
		expect(routeUnder(null, {repairBudgetSpent: "driver"})).toBe("founder");
	});
});
