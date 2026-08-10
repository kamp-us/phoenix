import {describe, expect, it} from "vitest";
import {
	candidatesFor,
	isQuestion,
	linesOf,
	mapTitle,
	namesSameThing,
	TITLE_LIMIT,
	truncateOnWordBoundary,
} from "./open.ts";

describe("isQuestion", () => {
	it("admits a line that closes with a question mark", () => {
		expect(isQuestion("does a suspended account keep its weight?")).toBe(true);
	});

	it("admits a line that opens with an interrogative and closes without one", () => {
		expect(isQuestion("what clock does weight decay on")).toBe(true);
	});

	it("refuses a line stated as a deliverable — the grammar is what makes 17 provable", () => {
		expect(isQuestion("build the invite acceptance form")).toBe(false);
		expect(isQuestion("")).toBe(false);
	});

	it("reads a Turkish opening word as prose rather than as an interrogative", () => {
		expect(isQuestion("kefil sistemi kurulacak")).toBe(false);
	});
});

describe("linesOf", () => {
	it("keeps the arrival order and drops blank lines", () => {
		expect(linesOf("one?\n\n  two?  \n")).toEqual(["one?", "two?"]);
	});
});

describe("truncateOnWordBoundary", () => {
	it("leaves a short string alone", () => {
		expect(truncateOnWordBoundary("short", 20)).toBe("short");
	});

	it("never ends mid-word", () => {
		expect(truncateOnWordBoundary("alpha beta gamma", 12)).toBe("alpha beta");
	});
});

describe("mapTitle", () => {
	it("prefixes the destination verbatim and fits the ceiling", () => {
		expect(mapTitle("how moderation weight is earned")).toBe(
			"wayfinding: how moderation weight is earned",
		);
		expect(mapTitle("weight ".repeat(80)).length).toBeLessThanOrEqual(TITLE_LIMIT);
	});
});

describe("namesSameThing", () => {
	it("matches two phrasings of one destination", () => {
		expect(
			namesSameThing("how moderation weight is earned", "how weight is earned by moderation"),
		).toBe(true);
	});

	it("does not match on one shared token, which carries no information about this destination", () => {
		expect(namesSameThing("moderation weight", "invite acceptance")).toBe(false);
	});

	it("refuses to answer yes below the token floor rather than matching everything", () => {
		expect(namesSameThing("it", "it")).toBe(false);
	});
});

describe("candidatesFor", () => {
	it("reports the board rows that rank, with their scores", () => {
		const candidates = candidatesFor("does weight inherit from a kefil?", [
			{number: 9098, title: "Moderation weight is inherited from the kefil today"},
			{number: 9099, title: "The invite acceptance form needs a spinner"},
		]);
		expect(candidates.map((candidate) => candidate.issue)).toEqual([9098]);
		expect(candidates[0]?.score).toBeGreaterThan(1);
	});

	it("reports nothing rather than refusing — the ranking is evidence, never a proven answer", () => {
		expect(candidatesFor("does weight inherit from a kefil?", [])).toEqual([]);
	});
});
