import {describe, expect, it} from "vitest";
import {cameFromSection, readCameFrom, renderCameFrom, STANDALONE} from "./came-from.ts";

describe("renderCameFrom", () => {
	it("renders a ticket as an issue reference and nothing as standalone", () => {
		expect(renderCameFrom(5652)).toBe("#5652");
		expect(renderCameFrom(null)).toBe(STANDALONE);
	});
});

describe("readCameFrom round-trips what the writers compose", () => {
	it("reads back a bound section", () => {
		expect(readCameFrom(cameFromSection(5652))).toBe(5652);
	});

	it("reads a standalone section as no ticket", () => {
		expect(readCameFrom(cameFromSection(null))).toBeNull();
	});

	it("finds the section wherever it sits in a body", () => {
		const body = `A grilling session.\n\n## Question\n\nwhy?\n\n${cameFromSection(88)}`;
		expect(readCameFrom(body)).toBe(88);
	});
});

describe("readCameFrom answers null rather than a number it cannot prove", () => {
	it.each([
		["no section at all", "A grilling session. Nothing reaches for the heading.\n"],
		["a drifted heading level", "### Came from\n\n#5652\n"],
		["a drifted heading spelling", "## Came From\n\n#5652\n"],
		["a section holding prose", "## Came from\n\nthe founder mentioned it on a call\n"],
		["a section holding a bare number", "## Came from\n\n5652\n"],
		["an empty section", "## Came from\n"],
	])("reads %s as no ticket", (_case, body) => {
		expect(readCameFrom(body)).toBeNull();
	});
});
