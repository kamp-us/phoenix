import {describe, expect, it} from "vitest";
import {SHELL_STATES, shellOf} from "../wire/lane-brief.ts";
import {
	BUILD_CLAIM_BUDGET_MINUTES,
	budgetMinutesFor,
	DISPATCH_BUDGET,
	livenessOf,
	SHELL_BUDGETS,
} from "./shell-budget.ts";

describe("the horizon is derived from the work, and cannot go back to a fixed literal", () => {
	// The defect this table replaced: one number for the pipeline. A revision that collapses the rows
	// back to a single value reads as a fixed horizon however many rows it is written across, so the
	// distinctness is what the test binds — not the numbers, which the weekly machinery review tunes.
	it("does not give every shell the same horizon", () => {
		const minutes = new Set(SHELL_STATES.map((state) => SHELL_BUDGETS[state].minutes));
		expect(minutes.size).toBeGreaterThan(1);
	});

	// The shape of the work fixes the ordering even when tuning moves the numbers: a builder loops,
	// a reviewer reads once, a shipper walks a fixed chain and hands the wait off.
	it("orders the horizons by the shape of each shell's work", () => {
		expect(SHELL_BUDGETS.build.minutes).toBeGreaterThan(SHELL_BUDGETS.review.minutes);
		expect(SHELL_BUDGETS.review.minutes).toBeGreaterThan(SHELL_BUDGETS.ship.minutes);
	});

	it("carries a budget for every state that routes to a shell", () => {
		for (const state of SHELL_STATES) {
			expect(shellOf(state)).toBeTypeOf("string");
			expect(SHELL_BUDGETS[state].minutes).toBeGreaterThan(0);
		}
	});

	// A number with no recorded reason is a bare literal wearing a table's clothes.
	it("records the derivation beside every number", () => {
		for (const state of SHELL_STATES) {
			expect(SHELL_BUDGETS[state].why.trim().length).toBeGreaterThan(0);
		}
		expect(DISPATCH_BUDGET.why.trim().length).toBeGreaterThan(0);
	});

	it("judges a build claim against the builder's own budget", () => {
		expect(BUILD_CLAIM_BUDGET_MINUTES).toBe(SHELL_BUDGETS.build.minutes);
	});
});

describe("budgetMinutesFor", () => {
	it("takes the longest budget among the leaves that route to a shell", () => {
		expect(budgetMinutesFor(["ship", "build"])).toBe(SHELL_BUDGETS.build.minutes);
		expect(budgetMinutesFor(["review", "ship"])).toBe(SHELL_BUDGETS.review.minutes);
	});

	it("falls to the dispatch budget when nothing is driving", () => {
		expect(budgetMinutesFor(["queued"])).toBe(DISPATCH_BUDGET.minutes);
		expect(budgetMinutesFor([])).toBe(DISPATCH_BUDGET.minutes);
	});
});

describe("livenessOf", () => {
	const at = (iso: string): number => Date.parse(iso);

	it("is Dead once the age reaches the budget", () => {
		expect(
			livenessOf("2026-09-09T00:00:00.000Z", at("2026-09-09T00:40:00.000Z"), 40),
		).toMatchObject({_tag: "Dead", ageMinutes: 40, budgetMinutes: 40});
	});

	it("is Live one minute short of it", () => {
		expect(
			livenessOf("2026-09-09T00:00:00.000Z", at("2026-09-09T00:39:00.000Z"), 40),
		).toMatchObject({_tag: "Live", ageMinutes: 39});
	});

	// A clock that ran backwards floors at zero and reads Live: waiting costs a lap, a wrong eviction
	// costs a live shell's work.
	it("is Live when the clock ran backwards", () => {
		expect(
			livenessOf("2026-09-09T01:00:00.000Z", at("2026-09-09T00:00:00.000Z"), 40),
		).toMatchObject({_tag: "Live", ageMinutes: 0});
	});

	it("is Unreadable on an instant that does not parse — never Dead, never Live", () => {
		expect(livenessOf("whenever", at("2026-09-09T00:00:00.000Z"), 40)._tag).toBe("Unreadable");
	});
});
