import {describe, expect, it} from "vitest";
import {LANE_TOKENS, laneFor} from "./lane.ts";
import {STALL_TOKENS} from "./stall.ts";

const HOLDER = {ownerLogin: "someone-else", authorLogin: "the-author"};
const NOBODY = {ownerLogin: null, authorLogin: "the-author"};
const SELF = {ownerLogin: "the-author", authorLogin: "the-author"};

describe("the arrow SKILL.md §2 assigns each class", () => {
	it("sends the two classes the sweep exists to catch to review and ship", () => {
		expect(laneFor("ungated", NOBODY)).toBe("review");
		expect(laneFor("gated-unshipped", NOBODY)).toBe("ship");
	});

	it("splits claim-stale on whether the holder is the PR's author", () => {
		expect(laneFor("claim-stale", SELF)).toBe("author");
		expect(laneFor("claim-stale", HOLDER)).toBe("human");
	});

	it("splits linkage-refused on whether a lane holds the PR", () => {
		expect(laneFor("linkage-refused", NOBODY)).toBe("author");
		expect(laneFor("linkage-refused", HOLDER)).toBe("build");
	});

	it("names a person where the next move is an operator's or a reviewer's", () => {
		expect(laneFor("wedged", NOBODY)).toBe("human");
		expect(laneFor("check-surface", NOBODY)).toBe("human");
		expect(laneFor("blocked-human", NOBODY)).toBe("human");
	});

	it("answers nobody on red, whose lane the class alone cannot name", () => {
		expect(laneFor("red", NOBODY)).toBe("nobody");
	});
});

/**
 * Totality is the property the workflow relays on: an unmapped class would print an empty arrow into
 * a note's fixed first line, which is the malformed signal the closed vocabulary exists to prevent.
 */
describe("the lookup is total and closed", () => {
	it("answers a lane in the closed set for every stall token", () => {
		for (const token of STALL_TOKENS) {
			expect(LANE_TOKENS).toContain(laneFor(token, NOBODY));
			expect(LANE_TOKENS).toContain(laneFor(token, HOLDER));
		}
	});

	it("gives one strand one word — the same facts answer the same lane twice", () => {
		for (const token of STALL_TOKENS) {
			expect(laneFor(token, HOLDER)).toBe(laneFor(token, HOLDER));
		}
	});
});
