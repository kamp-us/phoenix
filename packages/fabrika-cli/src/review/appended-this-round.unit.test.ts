import {describe, expect, it} from "vitest";
import {type CriterionProvenance, criterionRow} from "./append.ts";
import {rowsAppendedOn} from "./appended-this-round.ts";

const SUBJECT: CriterionProvenance = {_tag: "Pull", pr: 4321};

const bodyWith = (...rows: ReadonlyArray<string>): string =>
	[
		"Build the thing.",
		"",
		"### Acceptance criteria",
		"",
		"- [ ] the first thing",
		...rows,
		"",
	].join("\n");

describe("rowsAppendedOn", () => {
	it("finds the rows this round routed, as the reviewer wrote them", () => {
		const read = rowsAppendedOn(
			bodyWith(criterionRow("a regression test covers qty > 1", SUBJECT, 1)),
			SUBJECT,
			1,
		);
		expect(read).toEqual({_tag: "Rows", rows: ["a regression test covers qty > 1"]});
	});

	it("ignores an earlier round's row — that one is supposed to be standing unmet", () => {
		const body = bodyWith(criterionRow("a regression test", SUBJECT, 1));
		expect(rowsAppendedOn(body, SUBJECT, 2)).toEqual({_tag: "Rows", rows: []});
	});

	it("ignores a row another subject's round routed", () => {
		const body = bodyWith(criterionRow("a regression test", {_tag: "Pull", pr: 9999}, 1));
		expect(rowsAppendedOn(body, SUBJECT, 1)).toEqual({_tag: "Rows", rows: []});
	});

	// The two halves of the Absent-vs-Malformed discrimination, and they answer differently on
	// purpose: absent is a PROVEN negative — `review append-criterion` refuses an issue carrying no
	// conforming block — while malformed is a body that may be hiding a routed row.
	it("reads an absent block as no row, and a malformed one as unreadable", () => {
		expect(rowsAppendedOn("Build the thing.\n", SUBJECT, 1)).toEqual({_tag: "Rows", rows: []});
		const malformed = rowsAppendedOn(
			"Build the thing.\n\n### Acceptance criteria\n\nsee the linked doc.\n",
			SUBJECT,
			1,
		);
		expect(malformed._tag).toBe("Unreadable");
	});
});
