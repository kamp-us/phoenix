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
		expect(renderCameFrom(6)).toBe("#6");
		expect(renderCameFrom(null)).toBe(STANDALONE);
	});
});

describe("read round-trips what the writers compose", () => {
	it("reads back a bound section", () => {
		expect(found(cameFromSection(6))).toBe(6);
	});

	it("reads a standalone section as a proven-unbound artifact", () => {
		expect(found(cameFromSection(null))).toBeNull();
	});
});

describe("read refuses the drifts its registry fixtures do not carry", () => {
	it.each([
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
		expect(ticketOf("#6" as CameFromBinding)).toBe(6);
		expect(ticketOf(STANDALONE as CameFromBinding)).toBeNull();
	});
});
