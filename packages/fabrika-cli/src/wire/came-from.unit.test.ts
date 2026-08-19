import {describe, expect, it} from "vitest";
import {
	type CameFromBinding,
	cameFromSection,
	read,
	renderCameFrom,
	STANDALONE,
	ticketOf,
} from "./came-from.ts";

const found = (body: string): number | null => {
	const answer = read(body);
	if (answer._tag !== "Found")
		throw new Error(`expected Found, got ${answer._tag}: ${answer.reason}`);
	return ticketOf(answer.value.binding);
};

describe("renderCameFrom", () => {
	it("renders a ticket as an issue reference and nothing as standalone", () => {
		expect(renderCameFrom(5652)).toBe("#5652");
		expect(renderCameFrom(null)).toBe(STANDALONE);
	});
});

describe("read round-trips what the writers compose", () => {
	it("reads back a bound section", () => {
		expect(found(cameFromSection(5652))).toBe(5652);
	});

	it("reads a standalone section as a proven-unbound artifact", () => {
		expect(found(cameFromSection(null))).toBeNull();
	});

	it("finds the section wherever it sits in a body", () => {
		expect(found(`A grilling session.\n\n## Question\n\nwhy?\n\n${cameFromSection(88)}`)).toBe(88);
	});
});

describe("read separates a body with no section from one it could not parse", () => {
	it("answers Absent when nothing reaches for the heading", () => {
		const answer = read("A grilling session. Nothing reaches for the heading.\n");
		expect(answer._tag).toBe("Absent");
	});

	it("answers Absent on empty bytes", () => {
		expect(read("")._tag).toBe("Absent");
	});

	it.each([
		["a drifted heading level", "### Came from\n\n#5652\n"],
		["a drifted heading spelling", "## Came From\n\n#5652\n"],
		["a section holding prose", "## Came from\n\nthe founder mentioned it on a call\n"],
		["a section holding a bare number", "## Came from\n\n5652\n"],
		["an empty section", "## Came from\n"],
		["a section whose next line is the next heading", "## Came from\n\n## Question\n\nwhy?\n"],
		["two conforming headings", "## Came from\n\n#1\n\n## Came from\n\n#2\n"],
	])("answers Malformed on %s, never Absent and never Found", (_case, body) => {
		const answer = read(body);
		expect(answer._tag).toBe("Malformed");
		if (answer._tag !== "Malformed") return;
		expect(answer.reason).not.toBe("");
		expect(answer.evidence).not.toBe("");
	});
});

describe("ticketOf", () => {
	it("projects a reference to its number and standalone to nothing", () => {
		expect(ticketOf("#5652" as CameFromBinding)).toBe(5652);
		expect(ticketOf(STANDALONE as CameFromBinding)).toBeNull();
	});
});
