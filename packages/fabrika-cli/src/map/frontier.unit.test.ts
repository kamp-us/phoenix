import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {MAP_BODY, parsed} from "./fixtures.test-support.ts";
import {
	counts,
	decisionCites,
	frontierToken,
	isTerminal,
	scanTicketMarkers,
	type Ticket,
} from "./frontier.ts";
import {
	composeFindingMarker,
	composeForkMarker,
	composeLaneMarker,
	composeRetiredMarker,
} from "./markers.ts";

const ticket = (over: Partial<Ticket> & Pick<Ticket, "state">): Ticket => ({
	number: 9142,
	kind: "research",
	question: "which table carries the weight column?",
	blockedBy: [],
	blocking: [],
	...over,
});

const comment = (id: number, body: string): CommentRecord => ({
	id,
	author: "usirin",
	createdAt: "2026-08-10T00:00:00Z",
	updatedAt: "2026-08-10T00:00:00Z",
	body,
});

describe("frontierToken", () => {
	it("is `empty` on zero tickets — a fact, and the ordinary state of a fresh map", () => {
		expect(frontierToken([])).toBe("empty");
	});

	it("is `awaiting-founder` when a decision ticket is open or forked", () => {
		expect(frontierToken([ticket({state: "open", kind: "decision"})])).toBe("awaiting-founder");
		expect(frontierToken([ticket({state: "forked", kind: "decision"})])).toBe("awaiting-founder");
	});

	it("is `lanes-pending` for a prototype out at a spike — work in flight is not a question he owes", () => {
		expect(frontierToken([ticket({state: "forked", kind: "prototype"})])).toBe("lanes-pending");
	});

	it("is `clear` only when every ticket is terminal", () => {
		expect(
			frontierToken([ticket({state: "graduated"}), ticket({number: 9143, state: "retired"})]),
		).toBe("clear");
		expect(
			frontierToken([ticket({state: "graduated"}), ticket({number: 9143, state: "open"})]),
		).toBe("lanes-pending");
	});
});

describe("counts", () => {
	it("tallies each state and derives `blocked` separately, so `open` and blocked both survive", () => {
		const tally = counts([
			ticket({number: 9142, state: "open"}),
			ticket({number: 9143, state: "open", blockedBy: [9142]}),
		]);
		expect(tally.open).toBe(2);
		expect(tally.blocked).toBe(1);
	});

	it("does not count a ticket blocked only by a terminal one", () => {
		const tally = counts([
			ticket({number: 9142, state: "graduated"}),
			ticket({number: 9143, state: "open", blockedBy: [9142]}),
		]);
		expect(tally.blocked).toBe(0);
	});
});

describe("isTerminal", () => {
	it("is exactly graduated and retired", () => {
		expect(["graduated", "retired"].every(isTerminal as (s: string) => boolean)).toBe(true);
		expect(
			["open", "lane-held", "lane-closed", "forked"].some(isTerminal as (s: string) => boolean),
		).toBe(false);
	});
});

describe("scanTicketMarkers", () => {
	it("pairs a finding with the lane before it, and a re-lane clears the earlier finding", () => {
		const scanned = scanTicketMarkers(9140, 9143, [
			comment(1, composeLaneMarker({map: 9140, ticket: 9143, nonce: "aaaaaaaa"})),
			comment(
				2,
				composeFindingMarker({map: 9140, ticket: 9143, outcome: "unreachable", nonce: "aaaaaaaa"}),
			),
			comment(3, composeLaneMarker({map: 9140, ticket: 9143, nonce: "bbbbbbbb"})),
		]);
		expect(scanned.lane).toEqual({nonce: "bbbbbbbb"});
		expect(scanned.finding).toBeNull();
	});

	it("ignores markers naming another map, whatever the sub-issue edge says", () => {
		const scanned = scanTicketMarkers(9140, 9143, [
			comment(1, composeLaneMarker({map: 9999, ticket: 9143, nonce: "aaaaaaaa"})),
		]);
		expect(scanned.lane).toBeNull();
	});

	it("reads the fork route and the retirement direction", () => {
		const scanned = scanTicketMarkers(9140, 9144, [
			comment(1, composeForkMarker({map: 9140, ticket: 9144, route: "session", issue: 9301})),
			comment(2, composeRetiredMarker({map: 9140, ticket: 9144, direction: "a decay curve"})),
		]);
		expect(scanned.fork).toEqual({route: "session", issue: 9301});
		expect(scanned.retired).toEqual({direction: "a decay curve"});
	});
});

describe("decisionCites", () => {
	const body = parsed(
		MAP_BODY.replace(
			"## Decisions\n",
			"## Decisions\n- the column is on the account row — from #9146\n- an invited çaylak starts at 0 — ruled on #9301 R2.3\n",
		),
	);

	it("resolves a research finding by the ticket it names", () => {
		expect(decisionCites(body, 9146, null)).toBe(true);
		expect(decisionCites(body, 9142, null)).toBe(false);
	});

	it("resolves a relayed ruling by the session the fork pointed at", () => {
		// A ruling cites the session, never the ticket, so this is the only way a forked decision
		// ticket can ever graduate.
		expect(decisionCites(body, 9144, 9301)).toBe(true);
		expect(decisionCites(body, 9144, 9302)).toBe(false);
	});
});
