import {describe, expect, it} from "vitest";
import {MAP_BODY, parsed} from "./fixtures.test-support.ts";
import {applyRecord, QUESTION_ID} from "./record.ts";

describe("QUESTION_ID", () => {
	it("admits R<round>.<n> and nothing else", () => {
		expect(QUESTION_ID.test("R2.3")).toBe(true);
		expect(QUESTION_ID.test("2.3")).toBe(false);
		expect(QUESTION_ID.test("R2")).toBe(false);
	});
});

describe("applyRecord", () => {
	it("appends the answer and removes the row in ONE string, so the two cannot separate", () => {
		const next = applyRecord(parsed(MAP_BODY), 9142, {
			text: "the weight column lives on the account row",
			authority: {_tag: "Finding", ticket: 9142},
		});
		expect(next).not.toBeNull();
		const body = parsed(next as string);
		expect(body.frontier).toEqual([]);
		expect(body.decisions).toEqual([
			{
				text: "the weight column lives on the account row",
				authority: {_tag: "Finding", ticket: 9142},
			},
		]);
	});

	it("composes the citation itself, so an entry can never be recorded without one", () => {
		const next = applyRecord(parsed(MAP_BODY), 9142, {
			text: "an invited çaylak starts at 0 karma",
			authority: {_tag: "Ruled", session: 9301, questionId: "R2.3"},
		});
		expect(next).toContain("— ruled on #9301 R2.3");
	});

	it("appends rather than rewriting, so a superseding answer leaves both on the record", () => {
		const once = applyRecord(parsed(MAP_BODY), 9142, {
			text: "first answer",
			authority: {_tag: "Finding", ticket: 9142},
		}) as string;
		const twice = applyRecord(parsed(once), 9146, {
			text: "second answer, replacing the first",
			authority: {_tag: "Finding", ticket: 9146},
		}) as string;
		expect(parsed(twice).decisions.map((entry) => entry.text)).toEqual([
			"first answer",
			"second answer, replacing the first",
		]);
	});

	it("leaves every other section's bytes alone", () => {
		const next = applyRecord(parsed(MAP_BODY), 9142, {
			text: "the weight column lives on the account row",
			authority: {_tag: "Finding", ticket: 9142},
		}) as string;
		expect(next).toContain("- what clock does weight decay on?");
		expect(parsed(next).destination).toBe("how moderation weight is earned");
	});
});
