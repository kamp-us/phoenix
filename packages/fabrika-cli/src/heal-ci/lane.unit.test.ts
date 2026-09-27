import {describe, expect, it} from "vitest";
import {buildBound, LANE_TOKENS, laneFor, STANDINGS} from "./lane.ts";
import {STALL_TOKENS} from "./stall.ts";

const HOLDER = {ownerLogin: "someone-else", authorLogin: "the-author", standing: "ours"} as const;
const NOBODY = {ownerLogin: null, authorLogin: "the-author", standing: "ours"} as const;
const SELF = {ownerLogin: "the-author", authorLogin: "the-author", standing: "ours"} as const;

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

	// The rebase is a repair round, so `build` takes a conflicted PR the pipeline owns — and it is
	// never `human`, which is the false operator escalation this class was minted to end.
	it("sends conflicted to build over a PR the pipeline owns, whatever holds it", () => {
		expect(laneFor("conflicted", NOBODY)).toBe("build");
		expect(laneFor("conflicted", HOLDER)).toBe("build");
		expect(laneFor("conflicted", SELF)).toBe("build");
		expect(laneFor("conflicted", {...NOBODY, standing: "granted"})).toBe("build");
	});

	it("never sends a PR the pipeline does not own to build — its author takes it", () => {
		for (const standing of ["foreign", "unknown", "unread"] as const) {
			expect(laneFor("conflicted", {...NOBODY, standing})).toBe("author");
			expect(laneFor("linkage-refused", {...HOLDER, standing})).toBe("author");
		}
	});

	it("asks for the standing exactly where an arm would name build", () => {
		expect(buildBound("conflicted", null)).toBe(true);
		expect(buildBound("linkage-refused", "someone-else")).toBe(true);
		expect(buildBound("linkage-refused", null)).toBe(false);
		for (const token of STALL_TOKENS) {
			for (const facts of [NOBODY, HOLDER]) {
				const reachesBuild = STANDINGS.some(
					(standing) => laneFor(token, {...facts, standing}) === "build",
				);
				expect(buildBound(token, facts.ownerLogin)).toBe(reachesBuild);
			}
		}
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
