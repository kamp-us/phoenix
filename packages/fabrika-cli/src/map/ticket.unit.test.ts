import {describe, expect, it} from "vitest";
import type {Ticket} from "./frontier.ts";
import {cycleFrom, reaches, ticketBody, ticketTitle, waitsOnGraph} from "./ticket.ts";

const ticket = (number: number, blockedBy: ReadonlyArray<number>): Ticket => ({
	number,
	kind: "research",
	question: `question ${number}`,
	state: "open",
	blockedBy,
	blocking: [],
});

/** 9143 waits on 9142; 9144 waits on 9143. */
const graph = waitsOnGraph([ticket(9142, []), ticket(9143, [9142]), ticket(9144, [9143])]);

describe("reaches", () => {
	it("follows waits-on edges transitively", () => {
		expect(reaches(graph, 9144, 9142)).toBe(true);
		expect(reaches(graph, 9142, 9144)).toBe(false);
	});

	it("terminates on a graph that already holds a loop", () => {
		const looped = waitsOnGraph([ticket(1, [2]), ticket(2, [1])]);
		expect(reaches(looped, 1, 3)).toBe(false);
	});
});

describe("cycleFrom", () => {
	it("finds nothing when the new ticket only extends the chain", () => {
		expect(cycleFrom(graph, [9144], [])).toBeNull();
		expect(cycleFrom(graph, [], [9142])).toBeNull();
	});

	it("names the loop when the new ticket both waits on and gates the same chain", () => {
		// new -> 9142 already, and 9144 -> new; 9144 reaches 9142, so the loop closes.
		expect(cycleFrom(graph, [9144], [9142])).toEqual({waitsOn: 9144, gates: 9142});
	});

	it("catches the degenerate loop where one ticket is named on both sides", () => {
		expect(cycleFrom(graph, [9142], [9142])).toEqual({waitsOn: 9142, gates: 9142});
	});
});

describe("what the ticket carries", () => {
	it("titles the ticket with the question verbatim", () => {
		expect(ticketTitle("  does better-auth mint a single-use token?  ")).toBe(
			"does better-auth mint a single-use token?",
		);
	});

	it("binds the body to its map", () => {
		expect(ticketBody("does it decay?", 9140)).toBe("does it decay?\n\nCharted on #9140.\n");
	});
});
