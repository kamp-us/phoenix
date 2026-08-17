import {describe, expect, it} from "vitest";
import * as lane from "../lane/codes.ts";
import * as recipe from "./codes.ts";
import {laneExit} from "./relay.ts";

describe("laneExit", () => {
	it("keeps the shared seats on their own numbers", () => {
		expect(laneExit(lane.MALFORMED_RECORD)).toBe(recipe.MALFORMED_RECORD);
		expect(laneExit(lane.LANE_ABSENT)).toBe(recipe.TARGET_ABSENT);
		expect(laneExit(lane.APPEND_UNKNOWN)).toBe(recipe.WRITE_UNKNOWN);
		expect(laneExit(lane.LANE_UNREADABLE)).toBe(recipe.PRECONDITION_UNKNOWN);
	});

	it("re-seats the two lane private codes this group spells differently", () => {
		expect(laneExit(lane.EVENT_REFUSED)).toBe(recipe.UNPARK_REFUSED);
		expect(laneExit(lane.TASK_UNKNOWN)).toBe(recipe.TASK_UNRESOLVED);
	});

	it("never relays a lane private code onto this group's park seats", () => {
		const relayed = [lane.EVENT_REFUSED, lane.TASK_UNKNOWN, lane.LANE_EXISTS, lane.NO_SHELL].map(
			laneExit,
		);

		expect(relayed).not.toContain(recipe.PARK_NOVEL);
		expect(relayed).not.toContain(recipe.PARK_HOLDS);
	});

	it("is UNKNOWN for a lane code it has no reading for, never a guess", () => {
		expect(laneExit(lane.TOPOLOGY_CYCLE)).toBe(recipe.PRECONDITION_UNKNOWN);
		expect(laneExit(99)).toBe(recipe.PRECONDITION_UNKNOWN);
	});
});
