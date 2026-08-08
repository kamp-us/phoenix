import {describe, expect, it} from "vitest";
import {parseRoadmap, roadmapRowFor} from "./roadmap.ts";

/** The shape of the real `ROADMAP.md`, cut to the two tables this module reads. */
const ROADMAP = `# Roadmap

## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Four Pillars | #17 | done |
| Geçit | #24 | active |
| Mecmua v2 | #25 | queued |

## Campaigns

Campaigns are bounded, milestone-backed pushes.

| Campaign | Milestone | State |
|----------|-----------|-------|
| Mentor Audit | #27 | active |
| fabrika campaign | #44 | active |

## Something else

| Not a table we read | #99 | ignored |
`;

describe("parseRoadmap", () => {
	it("reads the ## Arcs and ## Campaigns rows as name → milestone pairs", () => {
		const rows = parseRoadmap(ROADMAP);
		expect(rows.arcs).toEqual([
			{name: "Four Pillars", milestone: 17},
			{name: "Geçit", milestone: 24},
			{name: "Mecmua v2", milestone: 25},
		]);
		expect(rows.campaigns).toEqual([
			{name: "Mentor Audit", milestone: 27},
			{name: "fabrika campaign", milestone: 44},
		]);
	});

	it("stops at the next `## ` heading — a later table is not another arc", () => {
		expect(parseRoadmap(ROADMAP).arcs.map((r) => r.milestone)).not.toContain(99);
	});

	it("stops after the FIRST matching section, so a repeated heading appends nothing", () => {
		// The `## ` break is only observable here: a second `## Arcs` further down — a stray heading, a
		// quoted table, an archive block — would otherwise silently merge its rows into the live arcs.
		const rows = parseRoadmap(`## Arcs

| Arc | Milestone |
|-----|-----------|
| Live | #1 |

## Archive

## Arcs

| Arc | Milestone |
|-----|-----------|
| Retired | #2 |
`);
		expect(rows.arcs).toEqual([{name: "Live", milestone: 1}]);
	});

	it("drops the header and `|---|` separator rows without matching on their text", () => {
		expect(parseRoadmap(ROADMAP).arcs.map((r) => r.name)).not.toContain("Arc");
		expect(parseRoadmap(ROADMAP).arcs.some((r) => r.name.startsWith("---"))).toBe(false);
	});

	it("requires the second cell to be exactly `#<number>`, so a prose cell admits no row", () => {
		const rows = parseRoadmap(`## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Unpinned | TBD | queued |
| Almost | see #24 | queued |
`);
		expect(rows.arcs).toEqual([]);
	});

	it("reads an absent section as no rows, not as a failure", () => {
		expect(parseRoadmap("# Roadmap\n\nNo tables here.\n")).toEqual({arcs: [], campaigns: []});
	});
});

describe("roadmapRowFor", () => {
	const rows = parseRoadmap(ROADMAP);

	it("joins on the `#<number>` cell, NOT the title — the two share no substring", () => {
		// `Geçit` pins milestone #24, whose GitHub title is `Sözlük — search and discovery`.
		expect(roadmapRowFor(rows, 24)).toBe("Geçit");
	});

	it("finds a campaign row too", () => {
		expect(roadmapRowFor(rows, 44)).toBe("fabrika campaign");
	});

	it("prefers an arc over a campaign pinning the same milestone", () => {
		const both = parseRoadmap(`## Arcs

| Arc | Milestone |
|-----|-----------|
| The arc | #5 |

## Campaigns

| Campaign | Milestone |
|----------|-----------|
| The campaign | #5 |
`);
		expect(roadmapRowFor(both, 5)).toBe("The arc");
	});

	it("answers null for an open milestone no row pins — a home that exists off the roadmap", () => {
		expect(roadmapRowFor(rows, 4831)).toBeNull();
	});
});
