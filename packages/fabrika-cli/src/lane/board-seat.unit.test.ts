/** The board seat — what admits a re-boot, and what the placed document declares afterwards. */
import {describe, expect, it} from "vitest";
import {adoptionRecord, seatFromProof, solePull, spendBudget} from "./board-seat.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {compileText} from "./machine.ts";

describe("solePull", () => {
	it("takes the one pull request the board hangs off the issue", () => {
		expect(solePull([9430])).toEqual({_tag: "One", pr: 9430});
	});

	it("refuses several, because which one the prior lane drove is not derivable", () => {
		const read = solePull([9430, 9431]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("#9430, #9431");
	});

	it("refuses an empty set rather than seating a lane on nothing", () => {
		expect(solePull([])._tag).toBe("Unproven");
	});
});

describe("seatFromProof", () => {
	it("seats a proven head, carrying the fold's own note", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "Proven", note: "every namespace answered"});

		expect(seat).toEqual({
			_tag: "Seatable",
			pr: 9430,
			head: "77aa05b",
			note: "every namespace answered",
		});
	});

	it("refuses a standing FAIL as a budget question, not a verdict question", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "Contradicted", what: "#9430 holds a FAIL"});

		expect(seat._tag).toBe("Unproven");
		expect(seat._tag === "Unproven" && seat.why).toContain("how many the prior lane already spent");
	});

	it("refuses an unfinished review with the fold's own words", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "InFlight", what: "#9430 has no verdict"});

		expect(seat).toEqual({_tag: "Unproven", why: "#9430 has no verdict"});
	});
});

describe("spendBudget", () => {
	it("declares the repair budget spent in the document the boot places", () => {
		const spent = spendBudget(coderTemplateText());
		if (spent._tag !== "Spent") throw new Error(`refused: ${spent.reason}`);
		const compiled = compileText(spent.text);
		if (compiled._tag === "Malformed") throw new Error(compiled.defects.join("; "));

		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(0);
	});

	it("leaves every other seeded field of the context alone", () => {
		const seeded = JSON.stringify({
			id: "coder",
			machine: {context: {issue: {retries: 0, maxRetries: 3, classes: ["ui"], maxLaps: 16}}},
		});
		const spent = spendBudget(seeded);
		if (spent._tag !== "Spent") throw new Error(`refused: ${spent.reason}`);

		expect(JSON.parse(spent.text)).toMatchObject({
			machine: {context: {issue: {classes: ["ui"], maxLaps: 16, maxRetries: 0}}},
		});
	});

	it("refuses a document with no task to declare it on", () => {
		expect(spendBudget(JSON.stringify({machine: {context: {}}}))._tag).toBe("Unseedable");
	});
});

describe("adoptionRecord", () => {
	it("names the pull request and the head the admission stood on", () => {
		const body = adoptionRecord(9435, 9430, "77aa05b8544ce06708376dcc8d57d15e2045324f");

		expect(body).toContain("<!-- fabrika-lane-from-board issue=9435 pr=9430");
		expect(body).toContain("#9430");
		expect(body).toContain("77aa05b8544ce06708376dcc8d57d15e2045324f");
	});

	it("states the seated budget, which is the fact a gitignored ledger cannot show a reader", () => {
		expect(adoptionRecord(9435, 9430, "77aa05b")).toContain("no repair budget");
	});

	it("names no filesystem path, because a board artifact carrying one is a leak", () => {
		expect(adoptionRecord(9435, 9430, "77aa05b")).not.toContain("/");
	});
});
