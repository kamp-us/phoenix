import {describe, expect, it} from "vitest";
import type {DecisionEntry, MapBody} from "./body.ts";
import {MAP_BODY, parsed} from "./fixtures.test-support.ts";
import {applyRecord, QUESTION_ID} from "./record.ts";

/** The composed body, or a thrown failure — the shape every applied case asserts against. */
const applied = (body: MapBody, ticket: number, entry: DecisionEntry): string => {
	const outcome = applyRecord(body, ticket, entry);
	if (outcome._tag === "Refused") throw new Error(`applyRecord refused: ${outcome.reason}`);
	return outcome.body;
};

describe("QUESTION_ID", () => {
	it("admits R<round>.<n> and nothing else", () => {
		expect(QUESTION_ID.test("R2.3")).toBe(true);
		expect(QUESTION_ID.test("2.3")).toBe(false);
		expect(QUESTION_ID.test("R2")).toBe(false);
	});
});

describe("applyRecord", () => {
	it("appends the answer and removes the row in ONE string, so the two cannot separate", () => {
		const next = applied(parsed(MAP_BODY), 9142, {
			text: "the weight column lives on the account row",
			authority: {_tag: "Finding", ticket: 9142},
		});
		const body = parsed(next);
		expect(body.frontier).toEqual([]);
		expect(body.decisions).toEqual([
			{
				text: "the weight column lives on the account row",
				authority: {_tag: "Finding", ticket: 9142},
			},
		]);
	});

	it("composes the citation itself, so an entry can never be recorded without one", () => {
		const next = applied(parsed(MAP_BODY), 9142, {
			text: "an invited çaylak starts at 0 karma",
			authority: {_tag: "Ruled", session: 9301, questionId: "R2.3"},
		});
		expect(next).toContain("— ruled on #9301 R2.3");
	});

	it("appends rather than rewriting, so a superseding answer leaves both on the record", () => {
		const once = applied(parsed(MAP_BODY), 9142, {
			text: "first answer",
			authority: {_tag: "Finding", ticket: 9142},
		});
		const twice = applied(parsed(once), 9146, {
			text: "second answer, replacing the first",
			authority: {_tag: "Finding", ticket: 9146},
		});
		expect(parsed(twice).decisions.map((entry) => entry.text)).toEqual([
			"first answer",
			"second answer, replacing the first",
		]);
	});

	it("leaves every other section's bytes alone", () => {
		const next = applied(parsed(MAP_BODY), 9142, {
			text: "the weight column lives on the account row",
			authority: {_tag: "Finding", ticket: 9142},
		});
		expect(next).toContain("- what clock does weight decay on?");
		expect(parsed(next).destination).toBe("how moderation weight is earned");
	});

	it("refuses a composed entry the parser would not read back, before any caller writes", () => {
		const outcome = applyRecord(parsed(MAP_BODY), 9142, {
			text: "the answer\nsplit over two lines",
			authority: {_tag: "Finding", ticket: 9142},
		});
		expect(outcome._tag).toBe("Refused");
	});
});
