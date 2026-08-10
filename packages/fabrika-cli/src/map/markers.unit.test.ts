import {describe, expect, it} from "vitest";
import {
	composeFindingMarker,
	composeForkMarker,
	composeLaneMarker,
	composeRetiredMarker,
	composeTicketMarker,
	isNonce,
	isOutcome,
	reachesForTicketMarker,
	readFindingMarker,
	readForkMarker,
	readLaneMarker,
	readRetiredMarker,
	readTicketMarker,
} from "./markers.ts";

describe("the nonce grammar", () => {
	it("admits eight lowercase hex characters and nothing else", () => {
		expect(isNonce("7f3a9c21")).toBe(true);
		// A human-readable label is exactly what two runs of one charting session would collide on.
		expect(isNonce("run-1")).toBe(false);
		expect(isNonce("7F3A9C21")).toBe(false);
		expect(isNonce("7f3a9c2")).toBe(false);
	});
});

describe("the outcome vocabulary", () => {
	it("is closed at three, so an absent answer cannot arrive as a fourth", () => {
		expect(["answered", "no-evidence", "unreachable"].every(isOutcome)).toBe(true);
		expect(isOutcome("none")).toBe(false);
		expect(isOutcome("")).toBe(false);
	});
});

describe.each([
	[
		"ticket",
		composeTicketMarker({map: 9140, kind: "research", nonce: "7f3a9c21"}),
		(body: string) => readTicketMarker(body),
		{map: 9140, kind: "research", nonce: "7f3a9c21"},
	],
	[
		"lane",
		composeLaneMarker({map: 9140, ticket: 9143, nonce: "7f3a9c21"}),
		(body: string) => readLaneMarker(body),
		{map: 9140, ticket: 9143, nonce: "7f3a9c21"},
	],
	[
		"finding",
		composeFindingMarker({map: 9140, ticket: 9143, outcome: "no-evidence", nonce: "7f3a9c21"}),
		(body: string) => readFindingMarker(body),
		{map: 9140, ticket: 9143, outcome: "no-evidence", nonce: "7f3a9c21"},
	],
	[
		"fork",
		composeForkMarker({map: 9140, ticket: 9144, route: "session", issue: 9301}),
		(body: string) => readForkMarker(body),
		{map: 9140, ticket: 9144, route: "session", issue: 9301},
	],
	[
		"retired",
		composeRetiredMarker({map: 9140, ticket: 9147, direction: "a decay curve nobody can predict"}),
		(body: string) => readRetiredMarker(body),
		{map: 9140, ticket: 9147, direction: "a decay curve nobody can predict"},
	],
])("the %s marker", (_name, composed, read, expected) => {
	it("round-trips composed bytes back to its fields", () => {
		expect(read(composed)).toEqual(expected);
	});

	it("is read off the first non-blank line only, so a quoted marker further down is not one", () => {
		expect(read(`someone said:\n\n${composed}\n`)).toBeNull();
	});

	it("does not read another marker's bytes", () => {
		expect(read("map-elsewhere: #9140 · nothing\n")).toBeNull();
	});
});

describe("readTicketMarker", () => {
	it("refuses an off-vocabulary kind rather than answering a plausible one", () => {
		expect(readTicketMarker("map-ticket: #9140 · investigation · 7f3a9c21")).toBeNull();
	});

	it("refuses a lane key two runs would collide on", () => {
		expect(readTicketMarker("map-ticket: #9140 · research · run-1")).toBeNull();
	});

	it("still REACHES for the format when it does not conform, so the child is disregarded not dropped", () => {
		expect(reachesForTicketMarker("map-ticket: #9140 · investigation · 7f3a9c21")).toBe(true);
		expect(reachesForTicketMarker("Picking this one up.")).toBe(false);
	});
});

describe("composeTicketMarker", () => {
	it("throws rather than emitting bytes its own reader would refuse", () => {
		expect(() => composeTicketMarker({map: 9140, kind: "research", nonce: "run-1"})).toThrow();
	});
});

describe("readFindingMarker", () => {
	it("refuses an outcome off the closed set — the absent answer never arrives as a fourth", () => {
		expect(readFindingMarker("map-finding: #9140 · #9143 · nothing-found · 7f3a9c21")).toBeNull();
	});
});
