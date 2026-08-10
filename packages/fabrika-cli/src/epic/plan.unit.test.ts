import {describe, expect, it} from "vitest";
import {EPIC_BODY} from "./fixtures.test-support.ts";
import {readOrder, readPlan} from "./plan.ts";

describe("readPlan", () => {
	it("derives every slice from the planned ledger", () => {
		const plan = readPlan(EPIC_BODY);
		expect(plan._tag).toBe("Plan");
		if (plan._tag !== "Plan") return;
		expect(plan.slices).toEqual([
			{id: "C1", issue: 4301, title: "extract the totals module"},
			{id: "C2", issue: 4302, title: "half-cent rounding fix"},
		]);
	});

	it("keeps a hyphenated title whole — the separator is the LAST one on the line", () => {
		const plan = readPlan("## Slices\n- C1: half-cent rounding — fix — #4302\n");
		expect(plan._tag).toBe("Plan");
		if (plan._tag !== "Plan") return;
		expect(plan.slices[0]?.title).toBe("half-cent rounding — fix");
	});

	it("refuses prose under the heading — an unparseable plan is never read as no slices", () => {
		const plan = readPlan("## Slices\n\nWe'll split this into a couple of chunks as we go.\n");
		expect(plan._tag).toBe("Unparseable");
	});

	it("refuses a body with no planned ledger at all", () => {
		expect(readPlan("## Dependencies\n- phase 1: #4301\n")._tag).toBe("Unparseable");
	});

	it("refuses a duplicate slice id — which line is C1 would be undecidable", () => {
		expect(readPlan("## Slices\n- C1: one — #1\n- C1: two — #2\n")._tag).toBe("Unparseable");
	});
});

describe("readOrder", () => {
	const slices = [
		{id: "C1", issue: 4301, title: "a"},
		{id: "C2", issue: 4302, title: "b"},
	];

	it("orders by the imported ## Dependencies topology", () => {
		const order = readOrder(EPIC_BODY, slices);
		expect(order).toEqual({_tag: "Order", order: ["C1", "C2"]});
	});

	it("breaks a tie by ascending ref, so two runs over one epic derive one order", () => {
		const body = "## Dependencies\n- phase 1: #4302, #4301\n";
		expect(readOrder(body, slices)).toEqual({_tag: "Order", order: ["C1", "C2"]});
	});

	it("refuses a missing ## Dependencies block rather than conducting in body order", () => {
		expect(readOrder("## Slices\n- C1: a — #4301\n", slices)._tag).toBe("Unparseable");
	});

	it("refuses a cycle instead of picking a slice to start with", () => {
		const body = "## Dependencies\n- C1 requires: C2\n- C2 requires: C1\n";
		expect(readOrder(body, slices)._tag).toBe("Unparseable");
	});
});
