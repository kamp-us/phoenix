import {describe, expect, it} from "vitest";
import {MERGEABILITY_WINDOW_SECONDS, pollWaits} from "./mergeability.ts";

describe("pollWaits", () => {
	it("backs off from 2s, doubling to a cap of 8s", () => {
		expect(pollWaits(60)).toEqual([2, 4, 8, 8, 8, 8, 8, 8, 6]);
	});

	it("spends exactly the window, so the refusal names a number it really waited", () => {
		for (const window of [0, 1, 2, 3, 6, 30, 60, 137]) {
			const waits = pollWaits(window);
			expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(window);
		}
	});

	it("waits not at all on a window of zero — one read, no re-read", () => {
		expect(pollWaits(0)).toEqual([]);
	});

	// The shipped window used to be 3 polls 2s apart. A conflicted PR whose background job had not
	// landed inside those 6s refused as UNKNOWN, and the read that would have said `dirty` was one
	// the loop never made. The default is a promise about how long the job gets, so it is pinned.
	// @ruling https://github.com/kamp-us/phoenix/issues/9032
	it("gives the lazy job a minute by default", () => {
		expect(MERGEABILITY_WINDOW_SECONDS).toBe(60);
		expect(pollWaits(MERGEABILITY_WINDOW_SECONDS)).toHaveLength(9);
	});
});
